# JSZip（同梱版）

Word（.docx）の読み込みに使うライブラリ。オフラインでも読み込めるよう、CDNではなくリポジトリに同梱している。

- バージョン：3.10.1（npm の `jszip@3.10.1` パッケージの `dist/jszip.min.js` をそのまま収録）
- 取得元の検証：npm レジストリの `dist.integrity`（`sha512-xXDvecyTpGLrqFrvkrUSoxxfJI5AH7U8zxxtVclpsUtMCq4JQ290LY8AW5c7Ggnr/Y/oK+bQMbqK2qmtk3pN4g==`）と一致することを確認済み
- `jszip.min.js` の SHA-256：`acc7e41455a80765b5fd9c7ee1b8078a6d160bbbca455aeae854de65c947d59e`
- ライセンス：MIT または GPLv3 のデュアルライセンス（`LICENSE.markdown` 参照）

更新するときは、新しいバージョンのファイルに差し替え、`index.html` の読み込み・`sw.js` の `PRECACHE_URLS`・このファイルの記載を合わせて更新する。
