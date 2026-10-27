# QZ1 iPhone

**Bluetooth GNSS受信機（QZ1）を、iPhoneで使うためのブリッジ。**

[English](README.md)

iPhoneは、QZ1のようなBluetooth Classic（SPP）の受信機に、直接つなげません。Safariには Web Serial も Web Bluetooth もなく、
アプリがBluetooth Classicの機器を使えるのは、AppleのMFi認定品だけです。
そこで、QZ1のそばに小さな **M5Stack Core2** を置きます。Core2が、QZ1とBluetooth Classicでつながり、NMEAを、ブラウザが受け取れる形で、iPhoneに渡します。

```
                                        ┌─ Wi-Fi（Core2自身のネットワーク）──> Safariなど（httpのページ。オフラインで動く）
QZ1 --Bluetooth Classic (SPP)--> Core2 ─┤
                                        └─ Bluetooth LE ─────────────────> Bluefy / Chrome（httpsのページ。Web Bluetooth）
```

パソコンも、クラウドも、アカウントも要りません。位置・測位の状態・衛星・スカイプロット・NMEAの記録（`.nmea`ファイル）を見られる、
外部ライブラリなしの表示ページが入っています。通信の決まりは短く、[docs/protocol.md](docs/protocol.md) に書いてあるので、自分のアプリをCore2につなぐこともできます。

[スイスイナビ](https://github.com/Klayertan/michibiki-suimon-navi)（準天頂衛星「みちびき」で水田を測る、水管理のWebアプリ）のために作りました。誰かの役に立てばと思い、公開します。

## 状況（先にお読みください）

趣味のプロジェクトです。確認できたことと、まだのことを、分けて書きます。

| | |
|---|---|
| Core2と、本物の**QZ1**の、Bluetooth Classicでの接続（約8行/秒のNMEA） | **実機で確認**（QZ1 1台、Core2 1台） |
| Core2のファームウェア（Wi-Fi、SDカードのページ、WebSocket、BLE、USBでのファイル転送） | **実機で確認**（このリポジトリの `firmware/` と同じコード）。ただし、ここでは、機器の名前を `config.h` に移し、文言を一般向けにしたので、この版は、**コンパイルは通りますが、書き込み直しての確認は、まだ**です |
| **iPhone**での通し動作 | 作者は「動いた」と言っています。iPhoneの機種・iOS・方法は、まだ記録していません。試したら、[Issue](../../issues) で教えてください |
| このリポジトリの表示ページ（`web/`） | パソコンのChromiumで、にせのブリッジを相手に確認（Wi-FiとBluetooth）。**iPhone実機では、まだです** |
| 他の受信機（NMEAを出すBluetooth Classic SPPの機器） | 未確認（動くはずです） |

測量級の精度を保証するものではありません。表示するのは、受信機が報告する値です。

## 必要なもの

- **M5Stack Core2**（ふつうのESP32）。**CoreS3は不可**です（ESP32-S3にはBluetooth Classicがありません）。
- 電源を入れた、QZ1。**ほかの機器とつながっていない**こと（同時に1台しか受けつけません）。
- USB-Cケーブル。microSDカード（FAT32。Wi-Fiモードだけ）。外で使うならモバイルバッテリー。
- Python 3 と Node 22以上のあるパソコン。
- iPhone側：Wi-FiモードならSafari。Bluetoothモードなら [Bluefy](https://apps.apple.com/app/id1492822055)（Web Bluetoothを足す、無料のブラウザ）。**iPhoneのChromeでは足りません**（iPhoneのブラウザは全部、AppleのWebKitで動き、Web Bluetoothがありません）。

## はじめかた

```bash
git clone https://github.com/Klayertan/QZ1-iPhone.git && cd QZ1-iPhone
npm test

pip install platformio
cp firmware/src/config.example.h firmware/src/config.h   # 編集する（QZ1のアドレスか名前、PIN）
cd firmware && pio run -t upload && cd ..

node tools/pack-sd.mjs                                   # Wi-Fiモード用のページを作る
pip install pyserial
python tools/upload-sd.py /dev/cu.usbserial-XXXX         # USBケーブルで、SDカードへ送る
```

QZ1のアドレスが分からないときは、先に書き込んで `pio device monitor` を見てください。Core2が、見つけた機器を `[bt] scan:` として表示します。

**Safari（Wi-Fiモード。最初はこちら）**：Core2の **A** ボタンでWi-FiのQRコードを出し、iPhoneのカメラで読んで参加します（ネットワーク名 `QZ1-Bridge-XXXX`、パスワードは初回に自動で作られ、Core2の中に保存されます）。Safariで `http://192.168.4.1/` を開き、**Connect (bridge Wi-Fi)**。
このページはhttpなので、iPhoneの仕様で、**スマホのGPS・コンパス・画面の常時点灯は使えません**。自動ロックを「なし」にしてください。

**Bluefy（Bluetoothモード）**：Core2の **B** ボタンを2秒押すと、Bluetoothモードで再起動します（Wi-Fiは切れます）。iPhoneのBluefyで、表示ページを **https** で開き（`web/` をGitHub Pagesなどに置く）、**Connect (Bluetooth)**。一覧からブリッジを選びます（iPhoneの設定でペアリングは不要）。

Core2のボタン：**A** 画面切り替え／**B** QZ1に再接続／**B長押し** モード切り替え／**C** 画面オフ。

詳しくは、[docs/how-it-works.md](docs/how-it-works.md)、[docs/troubleshooting.md](docs/troubleshooting.md)（英語）。

## ライセンス

MIT（[LICENSE](LICENSE)）。ファームウェアは Arduino-ESP32 と arduinoWebSockets（どちらもLGPL-2.1）、M5Unified / M5GFX（MIT）を使っています。表示ページに、外部のコードはありません。
