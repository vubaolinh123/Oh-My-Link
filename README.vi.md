# Oh-My-Link — Điều phối Đa Agent cho Claude Code

<p align="center">
  <a href="README.md">English / Tiếng Anh</a>
</p>

<p align="center">
  <em>Bảy giai đoạn. Mười hai agent. Phối hợp dựa trên file.<br/>
  Một pipeline có cấu trúc biến các yêu cầu phức tạp thành code production-ready đã qua review.</em>
</p>

<p align="center">
  <a href="#cài-đặt"><img src="https://img.shields.io/badge/Node.js-%3E%3D18-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js >= 18" /></a>&nbsp;
  <a href="#bắt-đầu-nhanh"><img src="https://img.shields.io/badge/Claude_Code-Plugin-7C3AED?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cGF0aCBkPSJNMTIgMkM2LjQ4IDIgMiA2LjQ4IDIgMTJzNC40OCAxMCAxMCAxMCAxMC00LjQ4IDEwLTEwUzE3LjUyIDIgMTIgMnoiIGZpbGw9IndoaXRlIi8+PC9zdmc+&logoColor=white" alt="Claude Code Plugin" /></a>&nbsp;
  <a href="#giấy-phép"><img src="https://img.shields.io/badge/License-MIT-blue?style=for-the-badge" alt="MIT License" /></a>
</p>

---

Oh-My-Link (OML) là một plugin cho Claude Code, chuyên điều phối các agent chuyên biệt thông qua workflow có cấu trúc. Được xây dựng từ việc nghiên cứu [mã nguồn Claude Code](https://github.com/anthropics/claude-code), OML tận dụng hệ thống hook, vòng đời subagent, và kiến trúc plugin để điều phối 12 agent xuyên suốt pipeline 7 giai đoạn. Toàn bộ phối hợp sử dụng **file-based JSON** — nhẹ, dễ di chuyển, và hoàn toàn khép kín.

## Bắt đầu nhanh

Chỉ cần gõ `start link` hoặc `start fast` trong Claude Code.

```
start link build me a REST API with auth      # Workflow đầy đủ 7 giai đoạn
start fast fix the login validation bug        # Workflow nhẹ 2 bước
cancel oml                                     # Hủy phiên làm việc hiện tại
```

## Hai chế độ

### Start Link — Workflow tự động hoàn chỉnh

Bảy giai đoạn với ba cổng human-in-the-loop (HITL) bắt buộc. Thiết kế cho các tính năng phức tạp, thay đổi đa file, và hệ thống mới.

- **Phase 1** — Scout làm rõ yêu cầu thông qua đối thoại Socratic
- **Gate 1** — Bạn duyệt các quyết định đã chốt
- **Phase 2** — Architect lập kế hoạch triển khai
- **Gate 2** — Bạn duyệt kế hoạch (có vòng phản hồi)
- **Phase 3** — Architect phân rã kế hoạch thành các task (link)
- **Phase 4** — Kiểm tra tính hợp lệ trên nhiều chiều
- **Gate 3** — Bạn chọn thực thi Tuần tự hoặc Song song
- **Phase 5** — Worker triển khai task với file locking
- **Phase 6** — Reviewer đánh giá từng task + review toàn bộ tính năng
- **Phase 7** — Tổng kết và tích lũy kinh nghiệm (learning flywheel)

### Start Fast — Workflow nhẹ

Hai bước, không có gate. Thiết kế cho sửa lỗi, thay đổi nhỏ, và tính năng nhanh.

| Tier | Khi nào | Điều gì xảy ra |
|------|---------|-----------------|
| **Turbo** | Thay đổi nhỏ (lỗi chính tả, sửa một dòng) | Thực thi trực tiếp, không cần lập kế hoạch |
| **Standard** | Task vừa phải (một tính năng, refactor nhỏ) | Scout nhanh → thực thi → xác minh |
| **Complex** | Phạm vi quá lớn | Chuyển sang Start Link đầy đủ |

## Sơ đồ Workflow

```
                        Start Link (7-phase)
                        ====================

  User ──> keyword-detector ──> prompt-leverage ──> Bootstrap
                                                       │
          ┌────────────────────────────────────────────┘
          v
  Phase 1: Scout (requirements clarification)
          │
      [GATE 1] ── user approves locked decisions
          │
  Phase 2: Architect (planning)
          │
      [GATE 2] ── user approves plan
          │
  Phase 3: Architect (decomposition into links/tasks)
          │
  Phase 4: Validation (pre-execution checks)
          │
      [GATE 3] ── user chooses Sequential / Parallel
          │
  Phase 5: Worker(s) implement links
          │
  Phase 6: Reviewer per-link + full-feature review
          │
  Phase 7: Summary + Compounding
          │
         Done


                        Start Fast (2-step)
                        ====================

  User ──> keyword-detector ──> prompt-leverage ──> Bootstrap
                                                       │
          ┌────────────────────────────────────────────┘
          v
  Step 1: Fast Scout (analyze, 0-2 questions)
          │
  Step 2: Executor (implement → verify → release)
          │
         Done
```

---

## Cài đặt

### Marketplace (khuyến nghị)

Thêm vào file `~/.claude/settings.json` của bạn:

```json
{
  "extraKnownMarketplaces": {
    "oh-my-link": {
      "source": {
        "source": "github",
        "repo": "vubaolinh123/Oh-My-Link"
      }
    }
  },
  "enabledPlugins": {
    "oh-my-link@oh-my-link": true
  }
}
```

Sau đó chạy `setup oml` trong Claude Code để khởi tạo workspace.

### Phát triển cục bộ

```bash
git clone https://github.com/vubaolinh123/Oh-My-Link.git
cd Oh-My-Link
npm install
npm run build
```

Claude Code tự động phát hiện `.claude-plugin/plugin.json` trong thư mục làm việc.

### Kiểm tra cài đặt

```
doctor oml
```

Nếu bất kỳ hook nào gặp lỗi, doctor sẽ chẩn đoán vấn đề và đề xuất cách khắc phục.

---

## Danh sách Agent & Cấu hình Model

Mỗi agent có một model mặc định được tối ưu cho vai trò của nó. Bạn có thể ghi đè bất kỳ cấu hình nào.

| Agent | Vai trò | Viết code | Model mặc định |
|-------|---------|:---------:|-----------------|
| **Master** | Điều phối pipeline 7 giai đoạn, quản lý gate | Không | `claude-opus-4-6` |
| **Scout** | Khảo sát codebase & làm rõ yêu cầu | Không | `claude-opus-4-6` |
| **Architect** | Lập kế hoạch, phân rã, tạo task | Không | `claude-opus-4-6` |
| **Code Reviewer** | Review chất lượng code chuyên sâu (style, pattern, bug) | Không | `claude-opus-4-6` |
| **Worker** | Triển khai từng task với file locking | Có | `claude-sonnet-4-6` |
| **Reviewer** | Review từng task và review toàn bộ tính năng | Không | `claude-sonnet-4-6` |
| **Fast Scout** | Phân tích nhanh cho chế độ Start Fast | Không | `claude-sonnet-4-6` |
| **Executor** | Chạy lệnh, triển khai cho Start Fast | Có | `claude-sonnet-4-6` |
| **Verifier** | Kiểm tra deliverable theo tiêu chí | Không | `claude-sonnet-4-6` |
| **Security Reviewer** | Kiểm tra bảo mật theo OWASP | Không | `claude-sonnet-4-6` |
| **Test Engineer** | Viết và chạy test | Chỉ test | `claude-sonnet-4-6` |
| **Explorer** | Tìm kiếm nhanh và khớp pattern trong codebase | Không | `claude-haiku-4-5` |

### Tại sao lại chọn những model mặc định này?

- **Opus** cho các vai trò cần suy luận sâu: Master (quyết định điều phối), Scout (phân tích yêu cầu), Architect (thiết kế), Code Reviewer (đánh giá chất lượng)
- **Sonnet** cho các vai trò nặng về thực thi: Worker (viết code), Reviewer (đánh giá có cấu trúc), Executor (triển khai nhanh)
- **Haiku** cho Explorer — tìm kiếm nhẹ, ưu tiên tốc độ hơn chiều sâu

### Tùy chỉnh cấu hình Model

**Cấu hình toàn cục** — áp dụng cho tất cả project:

Tạo hoặc sửa file `~/.oh-my-link/config.json`:

```json
{
  "models": {
    "master": "claude-opus-4-6",
    "scout": "claude-opus-4-6",
    "architect": "claude-opus-4-6",
    "worker": "claude-sonnet-4-6",
    "reviewer": "claude-sonnet-4-6",
    "fast-scout": "claude-sonnet-4-6",
    "executor": "claude-sonnet-4-6",
    "explorer": "claude-haiku-4-5-20251001",
    "verifier": "claude-sonnet-4-6",
    "code-reviewer": "claude-opus-4-6",
    "security-reviewer": "claude-sonnet-4-6",
    "test-engineer": "claude-sonnet-4-6"
  },
  "quiet_level": 0
}
```

**Bạn chỉ cần khai báo các vai trò muốn thay đổi.** Các vai trò không khai báo sẽ dùng giá trị mặc định ở trên.

**Cấu hình theo project** — ghi đè cấu hình toàn cục cho một workspace cụ thể:

Tạo file `{project}/.oh-my-link/config.json` với cùng định dạng. Giá trị project ghi đè giá trị toàn cục, giá trị toàn cục ghi đè giá trị mặc định.

```json
// .oh-my-link/config.json (theo project)
{
  "models": {
    "worker": "claude-opus-4-6"
  },
  "quiet_level": 1
}
```

#### Ví dụ

**Chế độ tiết kiệm** — dùng Sonnet cho mọi vai trò:
```json
{
  "models": {
    "master": "claude-sonnet-4-6",
    "scout": "claude-sonnet-4-6",
    "architect": "claude-sonnet-4-6",
    "code-reviewer": "claude-sonnet-4-6"
  }
}
```

**Chất lượng tối đa** — dùng Opus cho mọi vai trò:
```json
{
  "models": {
    "worker": "claude-opus-4-6",
    "reviewer": "claude-opus-4-6",
    "fast-scout": "claude-opus-4-6",
    "executor": "claude-opus-4-6",
    "explorer": "claude-opus-4-6",
    "verifier": "claude-opus-4-6",
    "security-reviewer": "claude-opus-4-6",
    "test-engineer": "claude-opus-4-6"
  }
}
```

#### Tham chiếu cấu hình

| Key | Kiểu | Mặc định | Mô tả |
|-----|------|----------|-------|
| `models` | `object` | Xem bảng ở trên | Model ID cho từng vai trò agent |
| `quiet_level` | `number` | `0` | `0` = chi tiết, `1` = ít output hơn, `2` = tối thiểu |

Vị trí file cấu hình (gộp theo thứ tự, giá trị sau ghi đè giá trị trước):
1. `~/.oh-my-link/config.json` (toàn cục) hoặc `$OML_HOME/config.json`
2. `{project}/.oh-my-link/config.json` (ghi đè theo project)

---

## Lệnh

| Lệnh | Mô tả |
|------|-------|
| `start link <request>` | Pipeline đầy đủ 7 giai đoạn cho task phức tạp |
| `start fast <request>` | Chế độ nhẹ cho task đơn giản |
| `cancel oml` | Hủy phiên làm việc hiện tại |
| `setup oml` | Chạy trình hướng dẫn cài đặt |
| `doctor oml` | Chẩn đoán tình trạng plugin |
| `update oml` | Cập nhật plugin |
| `fetch docs <topic>` | Lấy tài liệu từ bên ngoài |
| `learn this` | Lưu một pattern tái sử dụng từ phiên hiện tại |

**Tên thay thế:** `startlink`, `full mode`, `deep mode`, `oml` cũng kích hoạt Start Link. `startfast`, `quick start`, `fast mode`, `light mode` cũng kích hoạt Start Fast.

---

## Skill

| Skill | Mục đích |
|-------|----------|
| `using-oh-my-link` | Bootstrap và điểm khởi đầu cho Start Link |
| `mr-light` | Bootstrap và điểm khởi đầu cho Start Fast |
| `master` | Master Orchestrator (quản lý 7 giai đoạn) |
| `scout` | Phase 1 — Khám phá theo phong cách Socratic |
| `fast-scout` | Start Fast — phân tích nhanh |
| `architect` | Phase 2-4 — lập kế hoạch và phân rã |
| `worker` | Phase 5 — triển khai từng task |
| `reviewer` | Phase 6 — review từng task và review toàn bộ tính năng |
| `validating` | Phase 4 — kiểm tra trước khi thực thi |
| `swarming` | Phase 5 (song song) — điều phối worker đồng thời |
| `compounding` | Phase 7 — ghi nhận kinh nghiệm có cấu trúc |
| `debugging` | Khôi phục lỗi — phân loại, tái tạo, chẩn đoán, sửa |
| `prompt-leverage` | Tự động nâng cao prompt (cả hai chế độ) |
| `cancel` | Hủy phiên làm việc hiện tại |
| `doctor` | Chẩn đoán tình trạng workspace |
| `setup` | Khởi tạo workspace và các yêu cầu tiên quyết |
| `statusline` | Cấu hình HUD trực tiếp |
| `external-context` | Lấy và chèn tài liệu bên ngoài |
| `learner` | Học và trích xuất pattern |
| `update-plugin` | Tự cập nhật plugin |

---

## Tính năng

| Tính năng | Cách hoạt động |
|-----------|---------------|
| **Task Engine** | Task JSON trong `.oh-my-link/tasks/` với luồng trạng thái: `pending` → `in_progress` → `done` / `failed` |
| **File Locking** | Mutex nguyên tử dựa trên `mkdir` với TTL 30 giây. Worker phải lấy lock trước khi chỉnh sửa. |
| **Messaging** | File JSON trong `.oh-my-link/messages/` với định tuyến theo thread |
| **Session State** | `session.json` tại `~/.oh-my-link/projects/{hash}/` theo dõi phase, bộ đếm, lỗi |
| **Plugin Root Resolution** | Giải quyết đường dẫn 3 chiến lược: `CLAUDE_PLUGIN_ROOT` → `~/.oh-my-link/setup.json` → suy luận từ `__dirname` |
| **Auto Phase Tracking** | Hook vòng đời subagent tự động chuyển phase (chỉ tiến, không lùi) |
| **Prompt Leverage** | Mỗi lần gọi tự động bổ sung guardrail, ràng buộc, và tiêu chí thành công vào prompt |
| **Learnings** | Pattern được trích xuất từ các phiên trước được lưu và tải lại cho phiên sau (compounding flywheel) |

### Live Statusline

Plugin bao gồm một HUD hiển thị tiến trình theo thời gian thực:

```
╭─ OML v0.8.1 ✧ Start.Link ✧ Phase 5: Execution
╰─ Ctx: [♥♥♥♥♡♡♡♡♡♡] 42% ┊ Session: 9m ┊ Agents: SAW ┊ R:0 F:0
```

---

## Cấu trúc Project

```
Oh-My-Link/
├── src/                  # Mã nguồn TypeScript
│   ├── hooks/            # 10 hook handler cho Claude Code
│   ├── helpers.ts        # Tiện ích dùng chung
│   ├── state.ts          # Quản lý đường dẫn và trạng thái
│   ├── types.ts          # Định nghĩa kiểu
│   ├── task-engine.ts    # Hệ thống task + lock dựa trên file
│   ├── statusline.ts     # Renderer HUD trực tiếp
│   ├── config.ts         # Hệ thống cấu hình model
│   └── prompt-leverage.ts # Framework nâng cao prompt
├── scripts/
│   └── run.cjs           # Wrapper chạy hook (an toàn cho marketplace)
├── agents/               # 12 định nghĩa prompt cho agent
├── skills/               # Định nghĩa skill (20+ skill)
├── hooks/
│   └── hooks.json        # Cấu hình kết nối hook
├── test/                 # 138+ test trên 4 suite
├── .claude-plugin/       # Manifest cho marketplace
└── .oh-my-link/          # Artifact runtime (theo project, không commit)
    ├── plans/            # CONTEXT.md, plan.md, review.md
    ├── tasks/            # Task JSON
    ├── locks/            # File lock
    ├── messages/         # Thread nhắn tin giữa agent
    └── history/          # Lịch sử phiên, kinh nghiệm tích lũy
```

---

## Khái niệm chính

| Khái niệm | Mô tả |
|-----------|-------|
| **Links** | Các task trong task graph. Mỗi link có ID, phạm vi file, tiêu chí chấp nhận, và dependency. |
| **Gates** | Các checkpoint human-in-the-loop (G1, G2, G3). Không gì được tiến hành nếu không có sự phê duyệt của bạn. |
| **Review Gate** | Worker không tự hoàn thành task. Reviewer phải đưa ra kết luận PASS trước. |
| **File Locking** | Mutex nguyên tử ngăn chặn chỉnh sửa đồng thời. Worker phải lấy lock trước khi ghi. |
| **Prompt Leverage** | Mỗi lần gọi tự động bổ sung guardrail, ràng buộc, và tiêu chí thành công vào prompt. |
| **Learnings** | Pattern được trích xuất từ các phiên trước được lưu và tải lại cho phiên sau (compounding flywheel). |

---

## Hook

OML đăng ký 10 hook vào vòng đời Claude Code:

| Hook Event | Script | Mục đích |
|------------|--------|----------|
| `UserPromptSubmit` | `keyword-detector.js` | Phát hiện trigger `start link`, `start fast`, `cancel oml` |
| `UserPromptSubmit` | `skill-injector.js` | Chèn skill đã học vào context |
| `SessionStart` | `session-start.js` | Tải bộ nhớ project và trạng thái phiên |
| `PreToolUse` | `pre-tool-enforcer.js` | Hạn chế tool/đường dẫn theo vai trò |
| `PostToolUse` | `post-tool-verifier.js` | Theo dõi hot path, phản hồi skill |
| `PostToolUseFailure` | `post-tool-failure.js` | Theo dõi và xử lý lỗi tool |
| `Stop` | `stop-handler.js` | Tiếp tục phase, tín hiệu hủy, phát hiện kết thúc |
| `PreCompact` | `pre-compact.js` | Lưu trạng thái trước khi compact context |
| `SubagentStart/Stop` | `subagent-lifecycle.js` | Phát hiện vai trò agent, chuyển phase, tự động hoàn thành |
| `SessionEnd` | `session-end.js` | Dọn dẹp, giải phóng lock, lưu trữ phiên |

Tất cả hook sử dụng wrapper `run.cjs` để giải quyết đường dẫn an toàn cho marketplace — không commit đường dẫn tuyệt đối.

---

## Yêu cầu hệ thống

- **Node.js 18+** — tất cả script không có dependency bên ngoài
- **Claude Code** — môi trường host cho plugin

---

## Kiểm thử

```bash
npm run build
node test/run-tests.mjs           # 106 test cốt lõi
node test/test-run-cjs.mjs        # 6 test hook runner
node test/test-phase-tracking.mjs # 16 test phase tracking
node test/test-new-features.mjs   # 11 test resolution & config
```

139 test trên 4 suite bao phủ: phát hiện keyword, kiểm soát tool, quản lý trạng thái, task engine, file locking, prompt leverage, vòng đời session, phase tracking, giải quyết hook runner, giải quyết plugin root, và gộp config theo project.

---

## Khắc phục sự cố

Chạy skill doctor để chẩn đoán các vấn đề workspace:

```
doctor oml
```

Lệnh này kiểm tra cấu hình hook, tính toàn vẹn của file trạng thái, định nghĩa agent, và cấu trúc thư mục.

---

## Ghi công

Được xây dựng từ việc nghiên cứu [mã nguồn Claude Code](https://github.com/anthropics/claude-code) để hiểu hệ thống hook, vòng đời subagent, và kiến trúc plugin.

---

## Giấy phép

MIT

---

<p align="center">
  <sub>Được xây dựng cho Claude Code</sub>
</p>
