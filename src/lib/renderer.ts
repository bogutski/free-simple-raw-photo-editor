import { MIXER_CHANNELS, MIXER_COLORS, mixerKey, toneRange, type Adjustments } from "@/lib/adjustments";
import type { CropRect } from "@/lib/crop";
import { whiteBalance } from "@/lib/white-balance";
import type { LinearImage } from "@/lib/raw-decoder";

/*
 * Конвейер на GPU (WebGL2).
 *
 * 1. clean — исходное линейное изображение минус шум, найденный нейросетью.
 *    Шум = мелкая составляющая разницы «исходный − очищенный» (крупную, т.е. сдвиги
 *    тона и цвета от нейросети, отбрасываем). Цветовой шум убирается почти сразу,
 *    яркостный — пропорционально ползунку. С clean работают все следующие шаги.
 *
 * 2. Вспомогательные текстуры логарифма яркости (пересчитываются вместе с clean):
 *   log   — log2(Y) в полном разрешении;
 *   fine  — log, размытый на ~2 px: мелкие детали (Текстура);
 *   coarse — log в 1/8 разрешения, размытый на ~30 px с сохранением границ:
 *            крупные формы (Чёткость, маска для Света/Тени).
 *
 * На каждое движение ползунка выполняется один проход:
 *   баланс белого → экспозиция → локальный тон в log-яркости (текстура, чёткость, света, тени)
 *   → sRGB → белые/чёрные → контраст → сочность/насыщенность.
 */

const VERTEX = `#version 300 es
void main() {
  // Один треугольник на весь экран, без буферов вершин.
  vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
  gl_Position = vec4(p, 0.0, 1.0);
}`;

const HEADER = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
`;

/** Исходное изображение, смешанное с очищенным нейросетью, в float-текстуру. */
/** То, что убрала нейросеть: исходный − очищенный (считается один раз на кадр). */
const RESIDUAL = `${HEADER}
uniform usampler2D uImage;
uniform usampler2D uDenoised;
out vec4 outColor;
void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy);
  vec3 original = vec3(texelFetch(uImage, pos, 0).rgb) / 65535.0;
  vec3 denoised = vec3(texelFetch(uDenoised, pos, 0).rgb) / 65535.0;
  outColor = vec4(original - denoised, 1.0);
}`;

/** Одномерное гауссово размытие цветной текстуры (для крупной составляющей разницы). */
const BLUR_RGB = `${HEADER}
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uSigma;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 pos = ivec2(gl_FragCoord.xy);
  int radius = int(ceil(uSigma * 3.0));
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    sum += texelFetch(uSrc, clamp(pos + uDir * i, ivec2(0), size - 1), 0).rgb * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 1.0);
}`;

/** Исходное изображение минус шум: яркостная часть — по ползунку, цветовая — с опережением. */
const PREPARE = `${HEADER}
uniform usampler2D uImage;
uniform sampler2D uResidual;
uniform sampler2D uResidualLow;
uniform float uLumaAmount;
uniform float uChromaAmount;
out vec4 outColor;
void main() {
  ivec2 pos = ivec2(gl_FragCoord.xy);
  vec3 original = vec3(texelFetch(uImage, pos, 0).rgb) / 65535.0;
  // Только мелкая составляющая: крупная — это сдвиги тона и цвета от нейросети, не шум.
  vec3 noise = texelFetch(uResidual, pos, 0).rgb - texelFetch(uResidualLow, pos, 0).rgb;
  float lumaNoise = dot(noise, LUMA);
  vec3 chromaNoise = noise - vec3(lumaNoise);
  vec3 clean = original - uLumaAmount * vec3(lumaNoise) - uChromaAmount * chromaNoise;
  outColor = vec4(max(clean, 0.0), 1.0);
}`;

// --- Локальный тон ---------------------------------------------------------------

/** log2 яркости изображения после шумоподавления. */
const LOG_LUMA = `${HEADER}
uniform sampler2D uClean;
out vec4 outColor;
void main() {
  vec3 rgb = texelFetch(uClean, ivec2(gl_FragCoord.xy), 0).rgb;
  outColor = vec4(log2(dot(rgb, LUMA) + 1e-5), 0.0, 0.0, 1.0);
}`;

/** Уменьшение в FACTOR раз усреднением блока. */
const DOWNSAMPLE = `${HEADER}
uniform sampler2D uSrc;
uniform int uFactor;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 origin = ivec2(gl_FragCoord.xy) * uFactor;
  float sum = 0.0;
  float n = 0.0;
  for (int y = 0; y < uFactor; y++) {
    for (int x = 0; x < uFactor; x++) {
      ivec2 p = origin + ivec2(x, y);
      if (p.x < size.x && p.y < size.y) {
        sum += texelFetch(uSrc, p, 0).r;
        n += 1.0;
      }
    }
  }
  outColor = vec4(sum / max(n, 1.0), 0.0, 0.0, 1.0);
}`;

/**
 * Одномерное размытие; вызывается дважды — по горизонтали и по вертикали.
 * При uRange > 0 оно двустороннее (bilateral): соседи, яркость которых отличается
 * больше чем на ~uRange ступеней, не учитываются, и границы объектов не размываются.
 */
const BLUR = `${HEADER}
uniform sampler2D uSrc;
uniform ivec2 uDir;
uniform float uSigma;
uniform float uRange;
out vec4 outColor;
void main() {
  ivec2 size = textureSize(uSrc, 0);
  ivec2 pos = ivec2(gl_FragCoord.xy);
  float center = texelFetch(uSrc, pos, 0).r;
  int radius = int(ceil(uSigma * 3.0));
  float sum = 0.0;
  float wsum = 0.0;
  for (int i = -radius; i <= radius; i++) {
    float v = texelFetch(uSrc, clamp(pos + uDir * i, ivec2(0), size - 1), 0).r;
    float w = exp(-float(i * i) / (2.0 * uSigma * uSigma));
    if (uRange > 0.0) w *= exp(-(v - center) * (v - center) / (2.0 * uRange * uRange));
    sum += v * w;
    wsum += w;
  }
  outColor = vec4(sum / wsum, 0.0, 0.0, 1.0);
}`;

const DEVELOP = `${HEADER}
uniform sampler2D uClean;
uniform sampler2D uLog;
uniform sampler2D uFine;
uniform sampler2D uCoarse;

uniform mat3 uWhiteBalance;
uniform float uExposure;   // EV
uniform float uContrast;   // все остальные −1…+1
uniform float uHighlights;
uniform float uShadows;
uniform float uWhites;
uniform float uBlacks;
uniform float uTexture;
uniform float uClarity;
uniform float uVibrance;
uniform float uSaturation;
uniform float uSharpen;
// Color Mixer: по полосе спектра (Red…Magenta) сдвиг оттенка, насыщенности и яркости, −1…+1.
uniform float uMixHue[8];
uniform float uMixSat[8];
uniform float uMixLum[8];
// Кадрирование: левый верхний угол в пикселях изображения, высота холста и поворот
// фото под рамкой (радианы, по часовой стрелке, вокруг центра изображения).
uniform ivec2 uOffset;
uniform int uCanvasHeight;
uniform float uAngle;

out vec4 outColor;

const float MID_GREY = -2.4739; // log2(0.18)

vec3 toSrgb(vec3 c) {
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}

// S-кривая вокруг среднего серого. Чёрная и белая точки остаются на месте.
vec3 contrastCurve(vec3 x, float amount) {
  const float pivot = 0.46; // 18% серого после кодирования sRGB
  float k = exp2(amount);
  vec3 lo = pivot * pow(x / pivot, vec3(k));
  vec3 hi = 1.0 - (1.0 - pivot) * pow((1.0 - x) / (1.0 - pivot), vec3(k));
  return mix(lo, hi, step(pivot, x));
}

// Грубый уровень с учётом границ: соседи по сетке coarse с яркостью, далёкой от ref,
// почти не учитываются. Так тёмные волосы не «затемняют» светлый фон рядом — без ореолов.
float edgeAwareCoarse(vec2 uv, float ref) {
  vec2 texel = 1.0 / vec2(textureSize(uCoarse, 0));
  float sum = 0.0;
  float wsum = 0.0;
  for (int y = -2; y <= 2; y++) {
    for (int x = -2; x <= 2; x++) {
      float v = texture(uCoarse, uv + vec2(x, y) * texel).r;
      float d = v - ref;
      float w = exp(-float(x * x + y * y) / 4.0) * exp(-d * d / 0.5);
      sum += v * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-6);
}

// Резкость: нерезкое маскирование с радиусом ~1 px по логарифму яркости.
// Порог не даёт усиливать остаточное зерно, маска по градиенту сглаженной яркости
// оставляет гладкие участки (кожу, небо) нетронутыми — как Masking в Lightroom.
float sharpenDetail(ivec2 pos) {
  ivec2 size = textureSize(uLog, 0);
  float center = texelFetch(uLog, pos, 0).r;
  float blur = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      float w = float((2 - abs(x)) * (2 - abs(y))) / 16.0;
      blur += texelFetch(uLog, clamp(pos + ivec2(x, y), ivec2(0), size - 1), 0).r * w;
    }
  }
  float d = center - blur;
  d = sign(d) * max(abs(d) - 0.008, 0.0);

  ivec2 dx = ivec2(1, 0);
  ivec2 dy = ivec2(0, 1);
  vec2 gradient = vec2(
    texelFetch(uFine, clamp(pos + dx, ivec2(0), size - 1), 0).r - texelFetch(uFine, clamp(pos - dx, ivec2(0), size - 1), 0).r,
    texelFetch(uFine, clamp(pos + dy, ivec2(0), size - 1), 0).r - texelFetch(uFine, clamp(pos - dy, ivec2(0), size - 1), 0).r
  );
  float edges = smoothstep(0.01, 0.12, length(gradient));
  return 4.0 * d * edges;
}

// Насколько цвет близок к тону кожи (оранжевые оттенки 15°…50°).
float skinWeight(vec3 c) {
  float mx = max(c.r, max(c.g, c.b));
  float d = mx - min(c.r, min(c.g, c.b));
  if (d < 1e-4 || mx != c.r) return 0.0;
  float hue = 60.0 * (c.g - c.b) / d; // для «красной» области: −60°…60°
  return 1.0 - smoothstep(0.0, 20.0, abs(hue - 32.0));
}

vec3 toLinear(vec3 c) {
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

// Oklab: в нём смена оттенка и насыщенности почти не меняет видимую яркость.
vec3 linearToOklab(vec3 c) {
  vec3 lms = mat3(
    0.4122214708, 0.2119034982, 0.0883024619,
    0.5363325363, 0.6806995451, 0.2817188376,
    0.0514459929, 0.1073969566, 0.6299787005
  ) * c;
  lms = sign(lms) * pow(abs(lms), vec3(1.0 / 3.0));
  return mat3(
    0.2104542553, 1.9779984951, 0.0259040371,
    0.7936177850, -2.4285922050, 0.7827717662,
    -0.0040720468, 0.4505937099, -0.8086757660
  ) * lms;
}

vec3 oklabToLinear(vec3 c) {
  vec3 lms = mat3(
    1.0, 1.0, 1.0,
    0.3963377774, -0.1055613458, -0.0894841775,
    0.2158037573, -0.0638541728, -1.2914855480
  ) * c;
  lms = lms * lms * lms;
  return mat3(
    4.0767416621, -1.2684380046, -0.0041960863,
    -3.3077115913, 2.6097574011, -0.7034186147,
    0.2309699292, -0.3413193679, 1.7076392010
  ) * lms;
}

// Центры полос в градусах HSV, как в Lightroom; между соседними центрами веса плавно перетекают.
const float MIX_HUES[9] = float[9](0.0, 30.0, 60.0, 120.0, 180.0, 240.0, 270.0, 300.0, 360.0);

vec3 colorMixer(vec3 display) {
  float mx = max(display.r, max(display.g, display.b));
  float d = mx - min(display.r, min(display.g, display.b));
  if (d < 1e-4) return display;
  // Оттенок HSV, 0…360.
  float h = mx == display.r ? mod((display.g - display.b) / d, 6.0)
          : mx == display.g ? (display.b - display.r) / d + 2.0
          : (display.r - display.g) / d + 4.0;
  h *= 60.0;

  // Две соседние полосы, между которыми лежит оттенок, и плавный вес между ними.
  int i = 0;
  for (int k = 1; k < 8; k++) if (h >= MIX_HUES[k]) i = k;
  float t = smoothstep(0.0, 1.0, (h - MIX_HUES[i]) / (MIX_HUES[i + 1] - MIX_HUES[i]));
  int j = (i + 1) % 8;
  float hue = mix(uMixHue[i], uMixHue[j], t);
  float sat = mix(uMixSat[i], uMixSat[j], t);
  float lum = mix(uMixLum[i], uMixLum[j], t);
  if (hue == 0.0 && sat == 0.0 && lum == 0.0) return display;

  vec3 lab = linearToOklab(toLinear(display));
  float chroma = length(lab.yz);
  // Почти серые пиксели не трогаем: у них оттенок случаен.
  float colorful = smoothstep(0.0, 0.05, chroma);
  float angle = radians(30.0) * hue * colorful;
  float c = cos(angle);
  float s = sin(angle);
  lab.yz = mat2(c, s, -s, c) * lab.yz * max(0.0, 1.0 + sat * colorful);
  lab.x *= exp2(0.5 * lum * colorful);
  return toSrgb(clamp(oklabToLinear(lab), 0.0, 1.0));
}

void main() {
  ivec2 size = textureSize(uClean, 0);
  // Холст рисуется снизу вверх, данные изображения идут сверху вниз.
  vec2 local = vec2(gl_FragCoord.x, float(uCanvasHeight) - gl_FragCoord.y);
  // Точка исходного фото, которая попадает в этот пиксель после поворота.
  vec2 center = vec2(size) * 0.5;
  vec2 d = local + vec2(uOffset) - center;
  float c = cos(uAngle);
  float s = sin(uAngle);
  vec2 src = center + vec2(c * d.x + s * d.y, -s * d.x + c * d.y);
  if (src.x < 0.0 || src.y < 0.0 || src.x >= float(size.x) || src.y >= float(size.y)) {
    // За краем повёрнутого фото — фон окна (видно только в режиме кадрирования).
    outColor = vec4(vec3(0.04), 1.0);
    return;
  }
  ivec2 pos = ivec2(src);
  vec2 uv = src / vec2(size);

  // При повороте пиксели попадают между отсчётами — берём с билинейной интерполяцией.
  vec3 rgb = uAngle == 0.0 ? texelFetch(uClean, pos, 0).rgb : texture(uClean, uv).rgb;
  rgb = max(uWhiteBalance * rgb, 0.0) * exp2(uExposure);

  // --- Локальный тон: работаем с логарифмом яркости, цвет сохраняем через отношение.
  float y0 = dot(rgb, LUMA) + 1e-5;
  float L = log2(y0);
  float base = texelFetch(uLog, pos, 0).r + uExposure;
  float fine = texelFetch(uFine, pos, 0).r + uExposure;
  float coarse = edgeAwareCoarse(uv, fine - uExposure) + uExposure;
  // Значения из размытых текстур посчитаны до баланса белого; приводим к текущей яркости.
  float shift = L - base;
  fine += shift;
  coarse += shift;

  // Текстура: мелкие детали — разница между пикселем и слабым размытием.
  L += uTexture * (L - fine);
  L += uSharpen * sharpenDetail(pos);
  // Чёткость: средние детали, сильнее всего в средних тонах.
  float midtones = 1.0 - smoothstep(1.0, 4.0, abs(coarse - MID_GREY));
  L += uClarity * 0.8 * (fine - coarse) * midtones;

  // Света и тени: маска по смеси собственной и сглаженной яркости,
  // чтобы участок менялся целиком, а ореолы на границах были слабее.
  float m = mix(L, coarse, 0.7) - MID_GREY;
  float highlightMask = smoothstep(0.0, 2.5, m);
  float shadowMask = 1.0 - smoothstep(-6.0, 0.0, m);
  L += uHighlights * 1.5 * highlightMask;
  L += uShadows * 2.0 * shadowMask;

  rgb *= exp2(L) / y0;

  // --- Отображение.
  vec3 display = toSrgb(clamp(rgb, 0.0, 1.0));

  // Белые и чёрные двигают края тонального диапазона, почти не задевая середину.
  display += uWhites * 0.35 * pow(display, vec3(3.0));
  display += uBlacks * 0.2 * pow(1.0 - display, vec3(3.0));
  display = clamp(display, 0.0, 1.0);

  display = contrastCurve(display, uContrast);
  display = colorMixer(display);

  // Сочность усиливает слабые цвета и щадит тона кожи; насыщенность — все цвета одинаково.
  float luma = dot(display, LUMA);
  float sat = max(display.r, max(display.g, display.b)) - min(display.r, min(display.g, display.b));
  float vib = uVibrance * (1.0 - sat) * (uVibrance > 0.0 ? 1.0 - 0.6 * skinWeight(display) : 1.0);
  display = mix(vec3(luma), display, max(0.0, 1.0 + vib + uSaturation));

  outColor = vec4(clamp(display, 0.0, 1.0), 1.0);
}`;

type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer; width: number; height: number };

const COARSE_FACTOR = 8;

type TargetName =
  | "residual" | "residualTmp" | "residualLow"
  | "clean" | "log" | "fine" | "tmpFull" | "small" | "tmpSmall" | "coarse";

/** Размер «крупной» составляющей разницы, которую не считаем шумом (σ в пикселях). */
const RESIDUAL_SIGMA = 3;
/** Цветовой шум убирается быстрее яркостного: полностью уже при трети ползунка. */
const CHROMA_SPEED = 3;

/** Применяет настройки к линейному изображению на GPU. */
export class Renderer {
  private gl: WebGL2RenderingContext;
  private image: WebGLTexture;
  private denoised: WebGLTexture;
  private hasDenoised = false;
  private size = { width: 0, height: 0 };
  private programs: Record<
    "residual" | "blurRgb" | "prepare" | "logLuma" | "downsample" | "blur" | "develop",
    WebGLProgram
  >;
  private targets: Record<TargetName, Target> | null = null;
  /** Сила шумоподавления, для которой посчитаны clean и текстуры яркости. */
  private preparedDenoise: number | null = null;

  constructor(private canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2");
    if (!gl) throw new Error("WebGL2 is not available");
    // Нужен для рендеринга в текстуры с плавающей точкой.
    if (!gl.getExtension("EXT_color_buffer_float")) throw new Error("EXT_color_buffer_float is not supported");
    this.gl = gl;

    this.programs = {
      residual: createProgram(gl, RESIDUAL),
      blurRgb: createProgram(gl, BLUR_RGB),
      prepare: createProgram(gl, PREPARE),
      logLuma: createProgram(gl, LOG_LUMA),
      downsample: createProgram(gl, DOWNSAMPLE),
      blur: createProgram(gl, BLUR),
      develop: createProgram(gl, DEVELOP),
    };
    this.image = createTexture(gl, gl.NEAREST);
    this.denoised = createTexture(gl, gl.NEAREST);
  }

  setImage(image: LinearImage) {
    const { gl } = this;
    const { width, height } = image;
    this.size = { width, height };
    uploadRgb16(gl, this.image, image);
    this.hasDenoised = false;

    this.disposeTargets();
    const cw = Math.ceil(width / COARSE_FACTOR);
    const ch = Math.ceil(height / COARSE_FACTOR);
    this.targets = {
      residual: createTarget(gl, width, height, gl.NEAREST, "rgb"),
      residualTmp: createTarget(gl, width, height, gl.NEAREST, "rgb"),
      residualLow: createTarget(gl, width, height, gl.NEAREST, "rgb"),
      // Линейная фильтрация нужна для поворота.
      clean: createTarget(gl, width, height, gl.LINEAR, "rgb"),
      log: createTarget(gl, width, height, gl.NEAREST),
      fine: createTarget(gl, width, height, gl.NEAREST),
      tmpFull: createTarget(gl, width, height, gl.NEAREST),
      small: createTarget(gl, cw, ch, gl.NEAREST),
      tmpSmall: createTarget(gl, cw, ch, gl.NEAREST),
      // Линейная фильтрация: при чтении в полном разрешении грубый уровень плавно растягивается.
      coarse: createTarget(gl, cw, ch, gl.LINEAR),
    };
    this.preparedDenoise = null;
  }

  /** Очищенное нейросетью изображение того же размера; null — убрать. */
  setDenoised(image: LinearImage | null) {
    const { gl } = this;
    const t = this.targets;
    this.hasDenoised = image !== null && t !== null;
    this.preparedDenoise = null;
    if (!image || !t) return;

    uploadRgb16(gl, this.denoised, image);
    this.pass(this.programs.residual, t.residual, { uImage: this.image, uDenoised: this.denoised });
    const p = this.programs.blurRgb;
    const setup = (dx: number, dy: number) => () => {
      gl.uniform2i(gl.getUniformLocation(p, "uDir"), dx, dy);
      gl.uniform1f(gl.getUniformLocation(p, "uSigma"), RESIDUAL_SIGMA);
    };
    this.pass(p, t.residualTmp, { uSrc: t.residual.texture }, setup(1, 0));
    this.pass(p, t.residualLow, { uSrc: t.residualTmp.texture }, setup(0, 1));
  }

  /**
   * Рисует кадр с настройками. crop — область кадрирования или null для всего кадра,
   * angle — поворот фото под рамкой в градусах.
   */
  render(adj: Adjustments, crop: CropRect | null, angle: number) {
    const { gl, targets, size } = this;
    if (!targets) return;

    const denoise = this.hasDenoised ? adj.denoise / 100 : 0;
    if (denoise !== this.preparedDenoise) {
      this.pass(
        this.programs.prepare,
        targets.clean,
        { uImage: this.image, uResidual: targets.residual.texture, uResidualLow: targets.residualLow.texture },
        (p) => {
          gl.uniform1f(gl.getUniformLocation(p, "uLumaAmount"), denoise);
          gl.uniform1f(gl.getUniformLocation(p, "uChromaAmount"), Math.min(1, denoise * CHROMA_SPEED));
        },
      );
      this.buildLuma();
      this.preparedDenoise = denoise;
    }

    const r = crop ?? { x: 0, y: 0, w: 1, h: 1 };
    const left = Math.round(r.x * size.width);
    const top = Math.round(r.y * size.height);
    const width = Math.max(1, Math.round(r.w * size.width));
    const height = Math.max(1, Math.round(r.h * size.height));
    // Смена размера очищает холст, поэтому меняем его только при необходимости.
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }

    const p = this.programs.develop;
    const u = (name: string) => gl.getUniformLocation(p, name);
    this.pass(
      p,
      null,
      { uClean: targets.clean.texture, uLog: targets.log.texture, uFine: targets.fine.texture, uCoarse: targets.coarse.texture },
      () => {
        gl.uniform2i(u("uOffset"), left, top);
        gl.uniform1i(u("uCanvasHeight"), height);
        gl.uniform1f(u("uAngle"), (angle * Math.PI) / 180);
        // Матрица по строкам; transpose = true переводит её в порядок по столбцам, как ждёт GLSL.
        gl.uniformMatrix3fv(u("uWhiteBalance"), true, whiteBalance(adj.temp / 100, adj.tint / 100));
        gl.uniform1f(u("uExposure"), adj.exposure);
        for (const key of [
          "contrast", "texture", "clarity", "vibrance", "saturation", "sharpen",
        ] as const) {
          gl.uniform1f(u("u" + key[0].toUpperCase() + key.slice(1)), adj[key] / 100);
        }
        for (const [key, value] of Object.entries(toneRange(adj))) {
          gl.uniform1f(u("u" + key[0].toUpperCase() + key.slice(1)), value);
        }
        for (const ch of MIXER_CHANNELS) {
          const name = ch.id[0].toUpperCase() + ch.id.slice(1);
          gl.uniform1fv(u(`uMix${name}[0]`), MIXER_COLORS.map((c) => adj[mixerKey(ch.id, c.id)] / 100));
        }
      },
    );
  }

  /** Текстуры логарифма яркости для локального тона: log, fine, coarse. */
  private buildLuma() {
    const { gl } = this;
    const t = this.targets!;
    this.pass(this.programs.logLuma, t.log, { uClean: t.clean.texture });
    this.blur(t.log, t.tmpFull, t.fine, 2, 0);
    this.pass(this.programs.downsample, t.small, { uSrc: t.log.texture }, (p) =>
      gl.uniform1i(gl.getUniformLocation(p, "uFactor"), COARSE_FACTOR),
    );
    this.blur(t.small, t.tmpSmall, t.coarse, 4, 0.5);
  }

  /** Размытие src → dst: по горизонтали во временную текстуру tmp, затем по вертикали. */
  private blur(src: Target, tmp: Target, dst: Target, sigma: number, range: number) {
    const { gl } = this;
    const p = this.programs.blur;
    const setup = (dx: number, dy: number) => () => {
      gl.uniform2i(gl.getUniformLocation(p, "uDir"), dx, dy);
      gl.uniform1f(gl.getUniformLocation(p, "uSigma"), sigma);
      gl.uniform1f(gl.getUniformLocation(p, "uRange"), range);
    };
    this.pass(p, tmp, { uSrc: src.texture }, setup(1, 0));
    this.pass(p, dst, { uSrc: tmp.texture }, setup(0, 1));
  }

  private pass(
    program: WebGLProgram,
    target: Target | null,
    textures: Record<string, WebGLTexture>,
    setUniforms?: (p: WebGLProgram) => void,
  ) {
    const { gl } = this;
    gl.useProgram(program);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target?.framebuffer ?? null);
    gl.viewport(0, 0, target?.width ?? this.canvas.width, target?.height ?? this.canvas.height);
    Object.entries(textures).forEach(([name, tex], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
    });
    setUniforms?.(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private disposeTargets() {
    if (!this.targets) return;
    for (const t of Object.values(this.targets)) {
      this.gl.deleteTexture(t.texture);
      this.gl.deleteFramebuffer(t.framebuffer);
    }
    this.targets = null;
  }
}

// --- WebGL-утилиты ---------------------------------------------------------------

function uploadRgb16(gl: WebGL2RenderingContext, texture: WebGLTexture, image: LinearImage) {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2);
  gl.texImage2D(
    gl.TEXTURE_2D, 0, gl.RGB16UI, image.width, image.height, 0,
    gl.RGB_INTEGER, gl.UNSIGNED_SHORT, image.data,
  );
}

function createProgram(gl: WebGL2RenderingContext, fragment: string): WebGLProgram {
  const compile = (type: number, src: string) => {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(shader) ?? "Shader compilation failed");
    }
    return shader;
  };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(program) ?? "Shader program link failed");
  }
  return program;
}

function createTexture(gl: WebGL2RenderingContext, filter: number): WebGLTexture {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

/** Float-текстура (один канал или RGBA), в которую можно рисовать. */
function createTarget(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
  filter: number,
  channels: "r" | "rgb" = "r",
): Target {
  const texture = createTexture(gl, filter);
  if (channels === "r") gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, width, height, 0, gl.RED, gl.HALF_FLOAT, null);
  else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const framebuffer = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { texture, framebuffer, width, height };
}
