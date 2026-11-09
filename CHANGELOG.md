# Changelog

## 1.0.0 — 2026-11-08

First public release.

- Clipchamp-style editor: media panel, preview, one magnetic timeline with split, delete, trim, reorder, duplicate, undo/redo and frame stepping.
- Exports keep the source's resolution, frame rate, orientation and 10-bit/HDR colour tags.
- *Exact cuts* (frame-accurate re-encode) on NVIDIA NVENC, Intel Quick Sync or AMD AMF, with a per-video check of what each card can encode and CPU fallback; *Fast & lossless* stream copy.
- Video-card picker for PCs with more than one GPU.
- `Setup.bat` installs everything into the project folder from pinned, checksummed downloads.
- `npm test` drives the real app through an edit and every export path and verifies the output with ffprobe.
