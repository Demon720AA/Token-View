# Token View

แดชบอร์ดดู **token usage แบบเรียลไทม์** ของ LLM backends บนเครื่องของคุณ —
เห็นว่าแต่ละตัวกิน token ไปเท่าไร เหลือโควตาเท่าไร และ model ตัวไหนยังใช้ได้บ้าง

ไม่ต้องลง package ใด ๆ เพิ่ม — ใช้แค่ **Node.js 18+** (มี `node:sqlite` ในตัว) กับเบราว์เซอร์

หลักการสำคัญ: **core ไม่รู้จัก backend ใดเป็นพิเศษ** ทุกอย่างที่เฉพาะตัว
(ฐานข้อมูล, CLI, API ของแต่ละค่าย) อยู่ใน **plugins** ซึ่งเป็นไฟล์ local
ที่ไม่ถูก commit — core ที่อยู่บน GitHub มีแค่กลไกกลาง + ตัวอย่างวิธีต่อ

---

## มีอะไรให้ดูบ้าง

| หน้า | ที่อยู่ | เนื้อหา |
| --- | --- | --- |
| **All** | `/` | ภาพรวมทุก source: output tok/s, active requests, total tokens, requests, cost, quota remaining, กราฟ throughput 60 วินาที, การ์ด Source totals, สัดส่วนตาม model, live token feed |
| **Source** | `/<id>` | หน้าเฉพาะแต่ละ source (เช่น `/opencode`) + บล็อก account quota ขนาดใหญ่ถ้า plugin รายงานมา |
| **Models** | `/models` | รายชื่อ model จาก plugins — ตัวไหนต่อได้ (`in use`/`available`/`blocked`), limit, traffic ที่แต่ละตัวใช้ไป |
| **Detail** | `/detail` | ตารางราย model ครบทุกคอลัมน์ (input, output, cache read, reasoning, share, tok/s, requests, errors, cost, สัดส่วนตาม source, ใช้ล่าสุดเมื่อไร) |

เมนูด้านบนสร้างจาก sources ที่ตั้งค่าไว้ (`GET /api/sources`) อัตโนมัติ
ทุกหน้าอัปเดตผ่าน **Server-Sent Events (SSE)** ทุก 250ms ไม่ต้อง refresh เอง

## ทำงานอย่างไร

```
config/sources.json ──▶ server.js ◀── plugins/*.js ──▶ backend ของคุณ
                              │
                         SSE ──┴──▶ เบราว์เซอร์
```

- `config/sources.json` ประกาศว่ามี source อะไรบ้าง (ชื่อ, สี, โควตา) — แต่ละตัวได้หน้าเว็บที่ `/<id>` อัตโนมัติ
- `plugins/*.js` อ่านข้อมูลจริงจาก backend (ฐานข้อมูล, CLI, HTTP API) ทุก few วินาที
- ถ้าไม่มี config และไม่มี plugins เลย server จะรัน **demo traffic** ในตัวเพื่อให้หน้าจอไม่ว่าง

---

## สิ่งที่ต้องมี

- **Node.js 18 ขึ้นไป** — เช็คด้วย `node --version`
- **Linux + systemd** — ถ้าจะติดตั้งเป็น service (ถ้าไม่มีก็รัน `node server.js` ตรง ๆ ได้)

## ติดตั้ง

```bash
git clone https://github.com/Demon720AA/Token-View.git ~/Token-View
cd ~/Token-View
./install/install.sh
```

สคริปต์จะติดตั้ง 3 อย่าง:

1. **systemd user service** (`token-view.service`) — รัน server เบื้องหลัง เปิดเองตอน login พังแล้ว restart เอง
2. **คำสั่ง `token-view`** — เปิดแดชบอร์ดในหน้าต่างแยก (ใช้ Chromium/Brave `--app` ถ้ามี ไม่งั้นเปิดเบราว์เซอร์ปกติ)
3. **ไอคอนใน app menu** — ค้นหา "Token View" แล้วกดเปิดได้เลย

เสร็จแล้วเปิดที่ http://localhost:4173

```bash
./install/install.sh --no-start    # ติดตั้งอย่างเดียว ยังไม่ start
./install/install.sh --uninstall   # ลบทุกอย่างที่สคริปต์ติดตั้งไว้
```

### รันแบบไม่ติดตั้ง

```bash
cd ~/Token-View
node server.js              # http://localhost:4173
PORT=8080 node server.js    # เปลี่ยนพอร์ต
```

---

## ต่อ backend ของคุณ (3 ขั้น)

```bash
# 1. ประกาศ sources
cp config/sources.example.json config/sources.json   # แล้วแก้ id/label/color/quota
# 2. เปิดใช้ plugin
cp examples/plugins/opencode-db.js plugins/         # หรือเขียนเองตามข้อ 3
# 3. restart
systemctl --user restart token-view
```

`examples/` มีให้พร้อม (ดู `examples/README.md`):

| ไฟล์ | ใช้เมื่อ |
| --- | --- |
| `opencode-db.js` | อ่าน usage จริงจากฐานข้อมูล SQLite ของ opencode |
| `opencode-catalogue.js` | รายชื่อ/ราคา/reachability ของ model ผ่าน `opencode api` |
| `rest-poller.js` | **แม่แบบ**: backend มี HTTP endpoint ที่คืน JSON — กรอก URL + ปรับ `map()` |
| `cli-poller.js` | **แม่แบบ**: backend มีแต่ CLI ที่พิมพ์ JSON (เช่นคำสั่ง `/usage`) — กรอกคำสั่ง + ปรับ `map()` |
| `plugin-template.js` | โครงเปล่าพร้อมเอกสารครบ |

### เขียน plugin เอง

ไฟล์เดียว export `{ id, intervalMs, enabled?, poll }`:

```js
module.exports = {
  id: 'my-llm', // ต้องตรงกับ source id ใน config/sources.json
  intervalMs: 10_000,
  async poll() {
    return {
      total: { input: 1200, output: 340 },  // ยอดสะสม → แถบโควตา
      events: [ { model: 'x', inputTokens: 10, outputTokens: 5 } ], // ฟีดสด + กราฟ
      quota: { state: 'live', buckets: [ { group: 'Plan', name: 'Remaining',
               window: 'monthly', remainingFraction: 0.42,
               resetTime: '2026-11-01T00:00:00Z' } ], checkedAt: Date.now() },
      catalogue: { state: 'live', models: [ { id: 'x', provider: 'y',
                   context: 200000, reachable: true } ] },
    };
  },
};
```

ทุกฟิลด์ optional — คืนเฉพาะที่ backend มี, คืน `null` (หรือ throw) เมื่อต่อไม่ได้
source id ต้องเป็น `^[a-z0-9-]+$` เพราะกลายเป็น URL path (`/<id>`)

---

## ตั้งค่า (environment variables)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `PORT` | `4173` | พอร์ตที่ server ฟัง |
| `LIVE` | `true` | `false` = ไม่โหลด plugins รอรับข้อมูลจาก `POST /api/ingest` อย่างเดียว |
| `SIMULATE` | อัตโนมัติ* | `true` = เปิดตัวสร้าง traffic จำลอง |
| `PERIOD` | (ตาม config) | รอบรีเซ็ตโควตา: `hour` / `day` / `week` / `month` / `session` |
| `QUOTA_<ID>` | (ตาม config) | โควตา token ของ source นั้น เช่น `QUOTA_MY-LLM=1000000` |
| `QUOTACOST_<ID>` | (ตาม config) | เพดานค่าใช้จ่าย ($) ของ source นั้น |
| `TOKEN_VIEW_URL` | `http://localhost:4173` | URL ที่คำสั่ง `token-view` เปิด |

\* ถ้าไม่มี `config/sources.json` และไม่ตั้ง `SIMULATE` ไว้ server จะเปิด demo เอง

---

## API (สำหรับต่อยอด)

| Route | วิธี | ความหมาย |
| --- | --- | --- |
| `/api/stream` | SSE | `tick` (ภาพรวมทุก 250ms) + `event` (usage รายชิ้น) |
| `/api/summary` | GET | ภาพรวมครั้งเดียว (โครงเดียวกับ `tick`) |
| `/api/sources` | GET | รายชื่อ sources ที่ตั้งค่าไว้ (ใช้สร้างเมนู) |
| `/api/events?limit=100` | GET | event ล่าสุด ใหม่สุดก่อน |
| `/api/models` | GET | catalogue จาก plugins รวมกับ traffic ที่สังเกตได้ |
| `/api/ingest` | POST | บันทึก usage 1 ครั้ง: `{source?, model, inputTokens, outputTokens, app?, endpoint?, latencyMs?, error?}` |

ส่งยอดเองจากแอปของคุณ (ใช้กับ `LIVE=false`):

```bash
curl -X POST localhost:4173/api/ingest \
  -H 'content-type: application/json' \
  -d '{"source":"my-llm","model":"gpt-4o","inputTokens":1200,"outputTokens":340,"app":"my-app"}'
```

## โควตาที่เหลือ (แถบ meter)

- การ์ดแต่ละ source มี meter แสดง token ที่เหลือ เปอร์เซ็นต์ที่ใช้ และคาดการณ์ว่าจะหมดเมื่อไร (จากอัตราตอนนี้)
- สี: เขียว (<65%) → เหลือง (65–85%) → แดง (>85%) เกิน 100% เป็นลายทแยง
- ถ้า plugin รายงาน account quota มา หน้า source จะแสดงบล็อกใหญ่พร้อม % ที่เหลือ สถานะ และเวลานับถอยหลังถึงวันรีเซ็ต
- `cache read` แสดงแยกและ**ไม่นับเข้าโควตา** เพราะเป็น prompt-cache hit ไม่ใช่ token ใหม่

## ดูสถานะ service

```bash
systemctl --user status token-view    # ดูว่าทำงานอยู่ไหม
journalctl --user -u token-view -f    # ดู log แบบสด ([plugins] บอกว่าโหลดอะไรบ้าง)
systemctl --user stop token-view      # หยุด
systemctl --user start token-view     # เริ่ม
systemctl --user disable token-view   # ปิดไม่ให้เปิดเองตอน login
```

## โครงสร้างไฟล์

```
Token-View/
├── server.js                 # core: รวมยอด, โควตา, SSE, เสิร์ฟไฟล์ static
├── config/
│   ├── sources.example.json  # ต้นแบบ (commit) → ก็อปเป็น sources.json แล้วแก้
│   └── sources.json          # ของคุณ (git-ignored)
├── plugins/                  # plugins ของคุณ (git-ignored, มีแค่ .gitkeep ใน repo)
├── examples/
│   ├── README.md             # วิธีต่อ backend
│   ├── sources.json          # ตัวอย่าง config
│   └── plugins/              # opencode-db, opencode-catalogue, rest/cli poller, template
├── install/
│   ├── install.sh            # ติดตั้ง/ถอนการติดตั้ง
│   ├── token-view.service    # systemd user unit (ใช้ %h แทน home)
│   ├── token-view.desktop    # ไอคอน app menu
│   ├── token-view            # ตัวเปิดหน้าต่าง
│   └── token-view-server     # ตัวรัน server (หา node จาก PATH)
└── public/
    ├── index.html / app.js         # หน้า All
    ├── source.html / source.js     # หน้า /<id> (ทุก source ใช้ template เดียว)
    ├── models.html / models.js     # หน้า Models
    ├── detail.html / detail.js     # หน้า Detail
    ├── nav.js / style.css          # เมนูอัตโนมัติ + ธีม Tokyo Night terminal
```

## ความเป็นส่วนตัว

- ทุกอย่างรันบน `localhost` ไม่มีข้อมูลออกจากเครื่อง
- path ของ home directory ถูกย่อเป็น `~` ก่อนส่งออก API response
- `plugins/` และ `config/sources.json` ถูก git-ignore — ข้อมูลเฉพาะเครื่องไม่มีวันหลุดขึ้น GitHub
- systemd unit เปิดดิสก์ให้อ่านอย่างเดียว (เขียนได้เฉพาะโฟลเดอร์ log ที่ CLI บางตัวต้องใช้)

## แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุ / วิธีแก้ |
| --- | --- |
| `Port 4173 is already in use` | มีอีก instance รันอยู่ — `fuser -k 4173/tcp` หรือใช้ `PORT=4174 node server.js` |
| เห็นแต่ demo traffic | ยังไม่มี `config/sources.json` + plugins — ทำตามข้อ "ต่อ backend ของคุณ" |
| `[plugins] skipped: unknown source id` | `id` ใน plugin ไม่ตรงกับใน `config/sources.json` |
| หน้า Models ว่าง | ไม่มี plugin ตัวไหนคืน `catalogue` มา |
| ป้ายขึ้น `simulated` | รันด้วย `SIMULATE=true` หรือไม่มี plugins ที่โหลดได้ |
