# テストfixture

このフォルダーのファイルは、PDFマネージャーの回帰テスト専用です。顧客情報、個人情報、実在企業情報は含みません。

| ファイル | 作成方法・出典 | ライセンス | ページ数・用途 |
|---|---|---|---|
| `simple-2pages.pdf` | `npm run fixtures:generate`で決定論的に生成 | このリポジトリと同じ | 2ページ。結合・挿入用 |
| `simple-3pages.pdf` | `npm run fixtures:generate`で決定論的に生成 | このリポジトリと同じ | 3ページ。抽出・削除・並べ替え・回転用 |
| `japanese-text.pdf` | `npm run fixtures:generate`で日本語タイトルを含めて生成 | このリポジトリと同じ | 2ページ。日本語メタデータを含む一般PDFの読込用 |
| `compression-source.pdf` | `npm run fixtures:generate`で非可逆圧縮の効果が出やすい画像PDFを生成 | このリポジトリと同じ | 2ページ。圧縮用 |
| `sample.png` / `sample.jpg` | `npm run fixtures:generate`で生成 | このリポジトリと同じ | 画像PDF化・画像プレビュー用 |
| `sample.heic` | heic2any公式リポジトリの`demo/1.heic`を固定保存 | [MIT License](https://github.com/alexcorvi/heic2any/blob/master/LICENSE.md) | 1画像。HEIC変換・プレビュー用 |

CI実行中にfixtureを外部からダウンロードしません。`sample.heic`以外は生成スクリプトで再作成できます。
