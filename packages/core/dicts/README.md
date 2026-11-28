# WCDB zstd dictionaries

`5.zdict` is the `MsgDict` used by WeChat's WCDB message compression (zstd dictionary ID 5).
It is required to decode compressed `Message` / `MsgSource` values in newer iOS backups.

- Source: https://github.com/chclt/oh-my-wechat
- License of the dictionary collection: MIT
- SHA-256: `6413a19197f497ff9d45b18c5e7c78376b7a1020bcdaec8b5a0e04d03bd21a8c`
- Dictionary ID: `5`
- Size: 102400 bytes

Only dictionary 5 is vendored here; the other WCDB dictionaries (brand message dictionaries 1–4)
are not needed for chat message decoding.
