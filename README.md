# Token View

แดชบอร์ดดู **token usage แบบเรียลไทม์** ของ [opencode](https://opencode.ai) และ
[antigravity](https://antigravity.google) บนเครื่อง Linux ของคุณเอง —
เห็นว่าแต่ละตัวกิน token ไปเท่าไร เหลือโควตาเท่าไร และ model ฟรีตัวไหนยังใช้ได้บ้าง

ไม่ต้องลง package ใด ๆ เพิ่ม — ใช้แค่ **Node.js 18+** (มี `node:sqlite` ในตัว) กับเบราว์เซอร์

---

## มีอะไรให้ดูบ้าง

| หน้า | ที่อยู่ | เนื้อหา |
| --- | --- | --- |
| **All** | `/` | ภาพรวมทั้งสองตัว: output tok/s, active requests, total tokens, requests, cost, quota remaining, กราฟ throughput 60 วินาที, การ์ด Source totals, สัดส่วนตาม model, live token feed |
| **Antigravity** | `/antigravity` | หน้าเฉพาะ antigravity + **โควตารายสัปดาห์จริง** ที่อ่านจาก `agy` CLI |
| **OpenCode** | `/opencode` | หน้าเฉพาะ opencode |
| **Free models** | `/models` | model ฟรีทุกตัวของ opencode — ตัวไหนต่อได้ (`in use`/`available`/`blocked`), context/output limit, traffic ที่แต่ละตัวใช้ไป |
| **Detail** | `/detail` | ตารางราย model ครบทุกคอลัมน์ (input, output, cache read, reasoning, share, tok/s, requests, errors, cost, สัดส่วนตาม source, ใช้ล่าสุดเมื่อไร) |

ทุกหน้าอัปเดตผ่าน **Server-Sent Events (SSE)** ทุก 250ms ไม่ต้อง refresh เอง

## ทำงานอย่างไร

```
opencode.db (SQLite) ──┐
antigravity *.db ──────┼──▶ reader.js ──▶ server.js ──SSE──▶ เบราว์เซอร์
agy -p /usage ─────────┤       (ทุก 2 วิ)
opencode api /api/model┘
```

- `reader.js` อ่านยอดสะสมจากดิสก์ทุก 2 วินาที แล้วส่งเฉพาะ **ส่วนต่าง (delta)** เข้าฟีด
- `agy.js` ถามโควตา antigravity ผ่าน CLI ทุก 5 นาที (เรียกครั้งละ ~5 วิ)
- `opencode-models.js` ดึงรายชื่อ model จาก opencode service API ทุก 60 วิ
- ข้อมูลทั้งหมดอยู่บน `localhost` ไม่ส่งออกไปข้างนอก

---

## สิ่งที่ต้องมี

- **Node.js 18 ขึ้นไป** — เช็คด้วย `node --version`
- **Linux + systemd** — ถ้าจะติดตั้งเป็น service (ถ้าไม่มีก็รัน `node server.js` ตรง ๆ ได้)
- อย่างใดอย่างหนึ่ง (หรือไม่ต้องมีเลยก็ได้ — หน้านั้นจะขึ้นว่าไม่มีข้อมูล):
  - `opencode` CLI — สำหรับยอด usage จริง + หน้า Free models
  - `agy` CLI — สำหรับโควตา antigravity จริง

## ติดตั้ง (แนะนำ)

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

> สคริปต์คาดว่า repo อยู่ที่ `~/Token-View` ถ้า clone ไว้ที่อื่น ให้ย้ายมาก่อน

## รันแบบไม่ติดตั้ง

```bash
cd ~/Token-View
node server.js              # http://localhost:4173
PORT=8080 node server.js    # เปลี่ยนพอร์ต
```

---

## ใช้งาน

1. เปิด **Token View** จาก app menu (หรือรันคำสั่ง `token-view`, หรือเปิดเบราว์เซอร์ไปที่ http://localhost:4173)
2. แถบด้านบนมีลิงก์สลับหน้า: **All / Antigravity / OpenCode / Free models / Detail**
3. ป้ายมุมขวาบนบอกที่มาข้อมูล: `live data` (สีเขียว = อ่านจากเครื่องจริง) หรือ `simulated` (สีเหลือง = ข้อมูลจำลอง)
4. หน้า Free models บอกว่า model ฟรีตัวไหนยังต่อได้ — ถ้าขึ้น `blocked` แปลว่า opencode รายงานว่าใช้ไม่ได้ (เช่นโดน rate limit)

### ดูสถานะ service

```bash
systemctl --user status token-view    # ดูว่าทำงานอยู่ไหม
journalctl --user -u token-view -f    # ดู log แบบสด
systemctl --user stop token-view      # หยุด
systemctl --user start token-view     # เริ่ม
systemctl --user disable token-view   # ปิดไม่ให้เปิดเองตอน login
```

---

## ตั้งค่า (environment variables)

| ตัวแปร | ค่าเริ่มต้น | ความหมาย |
| --- | --- | --- |
| `PORT` | `4173` | พอร์ตที่ server ฟัง |
| `LIVE` | `true` | `false` = ไม่อ่านดิสก์ รอรับข้อมูลจาก `POST /api/ingest` อย่างเดียว |
| `SIMULATE` | `false` | `true` = เปิดตัวสร้าง traffic จำลองเพิ่ม (ไว้ทดสอบหน้าจอ) |
| `PERIOD` | (ตามโค้ด) | รอบรีเซ็ตโควตา: `hour` / `day` / `week` / `month` / `session` |
| `QUOTA_ANTIGRAVITY` / `QUOTA_OPENCODE` | `200000000` | โควตา token ของแต่ละตัว |
| `QUOTACOST_ANTIGRAVITY` / `QUOTACOST_OPENCODE` | (ไม่จำกัด) | เพดานค่าใช้จ่าย ($) ของแต่ละตัว |
| `AGY_BIN` | `agy` | path ของไบนารี antigravity CLI |
| `AGY_INTERVAL` | `300000` (5 นาที) | รอบถามโควตา antigravity (ms) |
| `AGY_TIMEOUT` | `90000` | timeout ของคำสั่ง `agy` (ms) |
| `OPENCODE_BIN` | `opencode` | path ของไบนารี opencode CLI |
| `OC_INTERVAL` | `60000` (1 นาที) | รอบดึงรายชื่อ model (ms) |
| `OC_TIMEOUT` | `30000` | timeout ของ `opencode api` (ms) |
| `TOKEN_VIEW_URL` | `http://localhost:4173` | URL ที่คำสั่ง `token-view` เปิด (ใช้เมื่อรันคนละพอร์ต) |

ตัวอย่าง:

```bash
PORT=8080 TOKEN_VIEW_URL=http://localhost:8080 token-view
QUOTA_ANTIGRAVITY=1000000 PERIOD=day node server.js
```

โควตาตั้งใน `SOURCES` ท้ายไฟล์ `server.js` ได้โดยตรงเช่นกัน (`quota: { tokens, costUsd, period }`)

---

## ที่มาของข้อมูลแต่ละส่วน

### opencode — ยอด token (แม่นยำ)

อ่านจาก SQLite `~/.local/share/opencode/opencode.db`:

- ตาราง `session_v2` มีคอลัมน์ `tokens_input/output/reasoning/cache_read/cache_write` และ `cost` แยกทุก session
- ตาราง `session_message` เก็บ usage ราย message ในฟิลด์ `data` (JSON) — เอามาเติม live feed

ยอดเป็นแบบสะสมตลอดกาล (all-time) ไม่ใช่รายเดือน

### antigravity — ยอด token (เท่าที่มี)

antigravity **แทบไม่บันทึก token ลงดิสก์** ไฟล์ `~/.gemini/antigravity-cli/conversations/*.db`
ไม่มีคอลัมน์ token เลย ต้องแกะตัวเลขออกจาก blob ที่ serialize ไว้ (ฟิลด์ `input_tokens`,
`cache_read_tokens`, `output_tokens`) ซึ่งมีอยู่แค่บาง conversation เท่านั้น
การ์ด antigravity จึงอาจค้างใกล้ศูนย์ — เป็นข้อจำกัดของการ log ของ antigravity เอง

### antigravity — โควตา (แม่นยำ)

antigravity **ไม่มี local API** (ไม่มี HTTP/gRPC/socket ให้เรียก) ช่องทางที่รองรับคือ CLI:

```bash
agy -p "/usage"   --output-format json   # ลิมิตรายสัปดาห์ + เวลารีเซ็ต
agy -p "/credits" --output-format json   # G1 credits ที่เหลือ
```

### opencode — รายชื่อ model ฟรี (แม่นยำ)

```bash
opencode api GET /api/model
```

คืน model ทั้งหมดพร้อมราคา สถานะ และลิมิต หน้า `/models` กรองเฉพาะตัวที่ `cost` เป็นศูนย์
แล้วจับคู่กับ traffic ที่แต่ละตัวใช้ไปบนเครื่องนี้

**"ต่อได้" ดูจากอะไร:** model นับว่า reachable เมื่อ opencode รายงาน `enabled: true` และ
`status: "active"` เป็นสัญญาณจาก catalogue ไม่ได้ยิง request ทดสอบจริง จึงไม่กินโควตา

---

## API (สำหรับต่อยอด)

| Route | วิธี | ความหมาย |
| --- | --- | --- |
| `/api/stream` | SSE | `tick` (ภาพรวมทุก 250ms) + `event` (usage รายชิ้น) |
| `/api/summary` | GET | ภาพรวมครั้งเดียว (โครงเดียวกับ `tick`) |
| `/api/events?limit=100` | GET | event ล่าสุด ใหม่สุดก่อน |
| `/api/models` | GET | รายชื่อ model ฟรี + traffic ของแต่ละตัว |
| `/api/ingest` | POST | บันทึก usage 1 ครั้ง: `{source?, model, inputTokens, outputTokens, app?, endpoint?, latencyMs?, error?}` |

`source` รับ `antigravity` หรือ `opencode` (ไม่ใส่ = `antigravity`)

### ส่งยอดเองจากแอปของคุณ

```bash
curl -X POST localhost:4173/api/ingest \
  -H 'content-type: application/json' \
  -d '{"source":"opencode","model":"gpt-4o","inputTokens":1200,"outputTokens":340,"app":"my-app"}'
```

Python:

```python
import requests
requests.post("http://localhost:4173/api/ingest", json={
    "source": "opencode",
    "model": "claude-sonnet-4",
    "inputTokens": 8000,
    "outputTokens": 420,
    "app": "support-bot",
})
```

Node (ห่อ OpenAI SDK):

```js
await fetch('http://localhost:4173/api/ingest', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    source: 'opencode',
    model: 'gpt-4o',
    inputTokens: res.usage?.prompt_tokens ?? 0,
    outputTokens: res.usage?.completion_tokens ?? 0,
    app: 'web-app',
  }),
});
```

---

## โควตาที่เหลือ (แถบ meter)

- การ์ดแต่ละ source มี meter แสดง token ที่เหลือ เปอร์เซ็นต์ที่ใช้ และคาดการณ์ว่าจะหมดเมื่อไร (จากอัตราตอนนี้)
- สี: เขียว (<65%) → เหลือง (65–85%) → แดง (>85%) เกิน 100% เป็นลายทแยง
- `cache read` แสดงแยกและ**ไม่นับเข้าโควตา** เพราะเป็น prompt-cache hit ไม่ใช่ token ใหม่
- รีเซ็ตอัตโนมัติเมื่อครบรอบ `period`

## โครงสร้างไฟล์

```
Token-View/
├── server.js            # รวมยอด, คำนวณโควตา, SSE, เสิร์ฟไฟล์ static
├── reader.js            # อ่าน usage จริงจากฐานข้อมูล opencode + antigravity
├── agy.js               # โควตา antigravity ผ่าน agy CLI
├── opencode-models.js   # รายชื่อ model ผ่าน opencode service API
├── install/
│   ├── install.sh           # ติดตั้ง/ถอนการติดตั้ง
│   ├── token-view.service   # systemd user unit (template, ใช้ %h แทน home)
│   ├── token-view.desktop   # ไอคอน app menu
│   ├── token-view           # ตัวเปิดหน้าต่าง
│   └── token-view-server    # ตัวรัน server (หา node จาก PATH)
└── public/
    ├── index.html / app.js       # หน้า All
    ├── source.html / source.js   # หน้า /antigravity และ /opencode
    ├── models.html / models.js   # หน้า Free models
    ├── detail.html / detail.js   # หน้า Detail
    └── style.css                 # ธีมมืด
```

## ความเป็นส่วนตัว

- ทุกอย่างรันบน `localhost` ไม่มีข้อมูลออกจากเครื่อง
- path ของ home directory ถูกย่อเป็น `~` ก่อนส่งออก API response
- systemd unit เปิดดิสก์ให้อ่านอย่างเดียว (เขียนได้เฉพาะโฟลเดอร์ log ของ opencode เอง
  เพราะคำสั่ง `opencode api` ต้องเปิดไฟล์ log เพื่อเขียน)

## แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุ / วิธีแก้ |
| --- | --- |
| `Port 4173 is already in use` | มีอีก instance รันอยู่ — `fuser -k 4173/tcp` หรือใช้ `PORT=4174 node server.js` |
| หน้า Free models ว่าง | opencode service ไม่รัน — เปิด opencode ทิ้งไว้ หรือเช็ค `journalctl --user -u token-view` |
| โควตา antigravity ขึ้น `unavailable` | `agy` เรียกไม่ได้ — เช็คว่า `agy -p "/usage"` รันได้ไหม (แต่ละครั้งใช้เวลา ~5 วิ) |
| การ์ด antigravity เป็นศูนย์ | ปกติ — antigravity ไม่บันทึก token ลงดิสก์ ดูส่วน "ที่มาของข้อมูล" |
| ป้ายขึ้น `simulated` | รันด้วย `SIMULATE=true` หรือไม่มีข้อมูลจริงบนเครื่อง |
