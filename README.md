# Free Simple RAW Photo Editor

A minimal, local RAW photo editor in the spirit of Lightroom's Develop module, built with Next.js.
Your RAW files never leave your machine and are never modified: edits are stored next to each file
in a small JSON sidecar.

## Features

- **RAW decoding in the browser** with LibRaw (WebAssembly), processed in linear light on the GPU (WebGL2).
- **Basic adjustments:** white balance (Temp/Tint), Exposure, Contrast, Lights & Darks, Texture, Clarity,
  Vibrance, Saturation, Sharpening.
- **Color Mixer:** Hue / Saturation / Luminance for eight color bands (Red … Magenta).
- **Crop & rotate** with aspect presets, portrait/landscape flip and drag-to-rotate.
- **Auto:** one-click adjustments, applied automatically when a photo is opened for the first time.
  White balance is estimated with the C5 neural network when its model is installed.
- **AI noise reduction** with SCUNet (optional, needs the model).
- **Filmstrip** with thumbnails that reflect your edits, multi-select, and copy/paste of color settings (⌘C / ⌘V).

## Getting started

```bash
pnpm install
pnpm dev
```

Open http://localhost:3000 and put your RAW files into the `sources/` folder.
Supported formats: RAF, DNG, NEF, NRW, ARW, SR2, SRF, CR2, ORF, PEF, RW2.

Edits are saved as `sources/<file>.json`. Thumbnails and AI results are cached in `.cache/`,
which can be deleted at any time.

## AI models (optional)

Model weights are not included in the repository. Put them into the `models/` folder:

| File | Used for | Source | License |
| --- | --- | --- | --- |
| `c5_m_7_h_64_w_g.onnx` | Auto white balance | [C5](https://github.com/mahmoudnafifi/C5), exported to ONNX | Apache-2.0 |
| `scunet_real_psnr_coreml_512.onnx` | AI noise reduction | [SCUNet](https://github.com/cszn/SCUNet), exported to ONNX with a fixed 512×512 input | Apache-2.0 |

Without the models the editor still works: Auto falls back to a statistical white balance,
and AI noise reduction is unavailable. Noise reduction uses ONNX Runtime's CoreML execution
provider and is tuned for Apple Silicon Macs.
