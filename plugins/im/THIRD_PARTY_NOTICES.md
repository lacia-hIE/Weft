# Third-party notices

The channel logos, Session channel title parsing and browser decoration, Host title decoration (`packages/harness-runtime/src/im-session-titles.ts`), and selected interface styles are adapted from [xmanrui/dsh-im](https://github.com/xmanrui/dsh-im), commit `b9baa78bf5750df9a2b340982e672c56c76e68e1`. The connection flow and layout follow that project, with transport and persistence adapted to Weft.

The workspace directory dialog (`src/workspace-picker.js` and its `dim-directory*` styles) is adapted from that project's `plugin-src/client/workspace-directory-picker.js` at the parity baseline `e278ac7da82384e6e21d907c606db6545fdc1d1e`, rendered in the Host `Modal` primitive with folder creation added.

The browser-compatible access policy and context enhancement modules in `src/reference/` are reused from the same project's `src/channels/shared/access-policy.mjs` and `context-enhancement.mjs` at commit `b9baa78bf5750df9a2b340982e672c56c76e68e1`. They are unchanged in the parity baseline `e278ac7da82384e6e21d907c606db6545fdc1d1e` (5.7.0). The following MIT notice also applies to these modules.

MIT License

Copyright (c) 2026 xmanrui

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Lark Node SDK

The Feishu registration and WebSocket wire protocol is adapted for Worker APIs with reference to `@larksuiteoapi/node-sdk@1.73.0` ([source](https://github.com/larksuite/node-sdk)).

MIT License

Copyright (c) 2022 Lark Technologies Pte. Ltd.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice, shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

## node-qrcode

QR version 11–40 capacity and alignment tables were cross-checked against `qrcode@1.5.4` ([source](https://github.com/soldair/node-qrcode)). No npm runtime dependency is added.

The MIT License (MIT)

Copyright (c) 2012 Ryan Day

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
