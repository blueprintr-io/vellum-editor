# File compatibility fixtures

`legacy.vellum` uses the supported single-diagram 1.0 envelope. The editable PNG and SVG contain the workspace-1.0 envelope and source markers used at commit `e97baafc16007e62bc0c2c5b0721898e5485d2ef`, before the September 2026 fixes. These are synthetic fixtures, not user files.

The PNG was constructed with that commit's `writePngChunk`, `pngTextChunk` and `insertPngChunks` functions. Its pixel data is a one-pixel red image. The SVG uses the same metadata ID, content type and XML escaping as the exporter at that commit. The tests read these fixed bytes rather than regenerating them with the current serializer.
