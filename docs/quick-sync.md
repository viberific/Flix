# Verify Intel Quick Sync (QSV)

The Flix image includes FFmpeg's `h264_qsv` encoder, Intel's oneVPL GPU runtime (`libmfx-gen1.2`), and the Intel VAAPI `iHD` driver. On x86-64, the Umbrel-generated compose must pass `/dev/dri` into the Flix container. Group access must include the host's `video` and `render` groups; device mapping alone is not proof that QSV works.

After the image has been built and deployed, run this inside the Flix container:

```sh
verify-qsv
```

The check automatically selects the first `/dev/dri/renderD*` node, or uses a path supplied as its first argument. It initializes oneVPL against that node, encodes a generated test pattern using `h264_qsv`, and confirms the resulting stream is H.264. Exit status 0 and `QSV OK` demonstrate an actual hardware encode; they do not merely check that the device or encoder name exists. To test a different render node, pass it as the first argument, for example `verify-qsv /dev/dri/renderD129`.

If it fails, inspect the full FFmpeg error. `no device` means compose device mapping is missing; permission errors mean the container's supplemental groups do not match the host device groups; a MFX session or implementation error points to the oneVPL runtime / media driver stack or GPU support. Flix itself probes QSV, then VAAPI, then CPU at startup and reports the encoder actually selected in its diagnostics/settings.
