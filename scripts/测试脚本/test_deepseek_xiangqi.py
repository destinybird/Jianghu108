#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
DeepSeek 象棋江湖残局统一评测脚本（flash / pro / vision 共用同一套 prompt）

仿照 前田陈尔/test_deepseek_unified.py 的写法。三模型使用【完全相同】的文字模板，
vision 只在此基础上附加棋盘图（boards/board_XXX.png），不加任何额外解释。

拼装方式（以第 1 题为例）：

    这是一局中国象棋高难度的江湖残局，……保证初始局面为合法局面。已知在双方最优
    应对下，本局红方胜，那么，在当前局面下，本局能成为正解的红方第一步是？请将你的
    答案选项字母放在<box>与</box>之间，如<box>X</box>
    红方棋子位置: 車B1 炮B4 炮B7 帥F2 兵F9
    黑方棋子位置: 馬A1 卒A2 卒A3 砲A5 士D10 車E5 将E10 士F10 象G6 卒I2 砲I5
    选项：
    A：炮B7 B10+
    B：炮B4 E4+
    C：車B1 E1
    D：兵F9 x F10+
    E：以上选项都不对

即：header 取到"保证初始局面为合法局面。"为止作 intro，然后按该题的 circumstance
插入胜负结论（"已知在双方最优应对下，本局红方胜，" 或 "已知在双方最优应对下，
本局红方无法取胜，为和棋，"），再接 header 的问句部分，最后是子力两行与选项。

用法：
  python test_deepseek_xiangqi.py --model flash               # flash 全 108 题，思考模式，108 并发
  python test_deepseek_xiangqi.py --model pro                 # pro 全 108 题
  python test_deepseek_xiangqi.py --model vision              # vision 全 108 题（附棋盘图）
  python test_deepseek_xiangqi.py --model flash --ids 1,5,23  # 只测指定题号
  python test_deepseek_xiangqi.py --model vision --ids 1 --dry-run   # 只打印拼好的 prompt
  python test_deepseek_xiangqi.py --model pro --batches 10    # 调低并发（默认 108）
  python test_deepseek_xiangqi.py --model flash --no-think    # 关闭思考模式（直接回答）

环境变量：DEEPSEEK_API_KEY（或用 --api-key / --base-url）

输出目录：results_unified/
  results_unified/{flash|pro|vision}_all_{ts}.jsonl
      —— 所有线程加锁逐行追加、每题即时 flush（中断不丢已完成行），完成后按题号排序
  单题（--ids 只给一题）：results_unified/{model}_id{id}_{ts}.jsonl，并打印 prompt 与回复。
"""

import base64
import json
import os
import re
import sys
import time
import argparse
import threading
from pathlib import Path
from datetime import datetime

BASE = Path(__file__).parent
if str(BASE) not in sys.path:
    sys.path.insert(0, str(BASE))

if sys.platform == "win32":
    os.system('')  # 启用 Windows 控制台的 ANSI 转义序列
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

JSON_PATH = BASE / "江湖残局.json"
BOARDS_DIR = BASE / "boards"
RESULT_DIR = BASE / "results_unified"
RESULT_DIR.mkdir(exist_ok=True)

MODELS = {
    "flash": "deepseek-v4-flash",
    "pro": "deepseek-v4-pro",
    "vision": "deepseek-v4-flash-vision-exp",
}
BAR_W = 12  # 每批进度条宽度（字符数）

# header 里"结论"要插在这句之前；把问句之前的部分作为 intro
MARKER = "那么，在当前局面下"
CONCLUSION = {
    "win": "已知在双方最优应对下，本局红方胜，",
    "draw": "已知在双方最优应对下，本局红方无法取胜，为和棋，",
}


# ---------------------------------------------------------------- 小工具

def parse_answer(text: str):
    """兜底答案提取：取正文里最后一个孤立的 A~E 字母"""
    if not text:
        return None
    hits = re.findall(r"(?<![A-Za-z])([A-Ea-e])(?![A-Za-z])", text)
    return hits[-1].upper() if hits else None


def format_eta(sec: float) -> str:
    sec = int(max(0, sec))
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def extract_usage(resp):
    u = getattr(resp, "usage", None)
    if u is None:
        return None
    return {k: getattr(u, k, None) for k in
            ("prompt_tokens", "completion_tokens", "total_tokens")}


# ---------------------------------------------------------------- prompt 拼装

def build_text_prompt(prob: dict) -> str:
    """统一 prompt（文本部分）——三模型共用，逐字一致。"""
    header = prob["header"]
    red = prob["Red"]
    black = prob["Black"]
    options = prob["options"]

    # 拆出问句：intro（到"保证初始局面为合法局面。"为止）+ 问句（"那么，在当前局面下…"）
    idx = header.find(MARKER)
    if idx != -1:
        intro = header[:idx].rstrip()
        question = header[idx:].strip()
    else:
        intro = header.rstrip()
        question = ""

    # 按该题的 circumstance 插入结论
    cs = prob.get("circumstance", "")
    key = "draw" if "无法取胜" in cs else "win"
    if intro.endswith("。"):
        intro_text = intro + CONCLUSION[key]
    else:
        intro_text = intro + "。" + CONCLUSION[key]

    # 问句末尾的句号去掉（与用户给的样例一致：…如<box>X</box>）
    question = question.rstrip()
    if question.endswith("。"):
        question = question[:-1]

    opts_text = "\n".join(options)
    return (f"{intro_text}{question}\n"
            f"红方棋子位置: {red}\n"
            f"黑方棋子位置: {black}\n"
            f"选项：\n{opts_text}")


def build_messages(prob: dict, with_image: bool, detail: str | None):
    """返回 (messages, text_part, image_name)

    - 文本模型：content 为纯字符串
    - 视觉模型：content 为 [文本块, 图片块]；图片不做任何文字解释
    """
    text = build_text_prompt(prob)
    if not with_image:
        return [{"role": "user", "content": text}], text, None

    img_path = BOARDS_DIR / f"board_{prob['id']:03d}.png"
    if not img_path.exists():
        raise FileNotFoundError(f"缺少棋盘图片: {img_path}")
    b64 = base64.b64encode(img_path.read_bytes()).decode("utf-8")
    image_block = {"type": "image_url",
                   "image_url": {"url": f"data:image/png;base64,{b64}"}}
    if detail:
        image_block["image_url"]["detail"] = detail
    return ([{"role": "user",
              "content": [{"type": "text", "text": text}, image_block]}],
            text, str(img_path.name))


def extract_answer(text: str) -> str | None:
    """优先提取 <box>X</box>（取最后一个），找不到再回退 parse_answer"""
    if not text:
        return None
    m = re.findall(r"<box>\s*([A-Ea-e])\s*</box>", text)
    if m:
        return m[-1].upper()
    return parse_answer(text)


def sort_file_by_id(path: Path) -> None:
    """把 jsonl 按 id 升序重写（并发追加得到的是完成顺序）"""
    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except Exception:
        return
    if len(lines) <= 1:
        return
    rows, bad = [], []
    for ln in lines:
        try:
            rows.append((json.loads(ln)["id"], ln))
        except Exception:
            bad.append(ln)
    rows.sort(key=lambda x: x[0])
    out = [ln for _, ln in rows] + bad
    path.write_text("\n".join(out) + ("\n" if out else ""), encoding="utf-8")


def load_problems(ids_arg: str | None):
    with open(JSON_PATH, "r", encoding="utf-8") as f:
        all_problems = json.load(f)["problems"]
    all_problems = [p for p in all_problems if p.get("name")]
    if ids_arg:
        want = {int(x.strip()) for x in ids_arg.split(",") if x.strip()}
        all_problems = [p for p in all_problems if p["id"] in want]
    return all_problems


# ---------------------------------------------------------------- 主流程

def main():
    parser = argparse.ArgumentParser(description="DeepSeek 象棋江湖残局统一评测（flash/pro/vision 同一 prompt）")
    parser.add_argument("--model", type=str, default="flash", choices=list(MODELS.keys()),
                        help="flash / pro / vision（默认 flash）")
    parser.add_argument("--think", action="store_true", default=True, help="思考模式（默认开启）")
    parser.add_argument("--no-think", dest="think", action="store_false", help="关闭思考模式")
    parser.add_argument("--batches", type=int, default=108,
                        help="并发数（默认 108 = 每题一个请求同时发；若限流可调低）")
    parser.add_argument("--ids", type=str, default=None, help="只测指定题号，逗号分隔，如 1,2,3")
    parser.add_argument("--max-tokens", type=int, default=131072, help="思考模式输出 token 上限")
    parser.add_argument("--detail", type=str, default=None,
                        help="vision 图片 detail: low / high / original / auto")
    parser.add_argument("--dry-run", action="store_true",
                        help="只打印选中题目的拼装 prompt（vision 同时打印图片路径），不发请求")
    parser.add_argument("--base-url", type=str, default="https://api.deepseek.com")
    parser.add_argument("--api-key", type=str, default=None)
    args = parser.parse_args()

    model_name = MODELS[args.model]
    with_image = (args.model == "vision")

    if args.dry_run:
        for prob in load_problems(args.ids):
            pid = prob["id"]
            img_path = BOARDS_DIR / ("board_%03d.png" % pid)
            print("=" * 60)
            if with_image:
                print("第 %d 题 prompt 预览（图片: board_%03d.png，存在=%s）" % (pid, pid, str(img_path.exists())))
            else:
                print("第 %d 题 prompt 预览" % pid)
            print("─" * 60)
            messages, text, _ = build_messages(prob, with_image, args.detail)
            print(text)
            if with_image:
                print("─" * 60)
                print("（图片以 data:image/png;base64,... 附加在文本块之后，无额外文字）")
        print("=" * 60)
        print("dry-run 结束：以上为将发送给模型的完整文本内容。")
        return

    api_key = args.api_key or os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
        print("错误：请设置环境变量 DEEPSEEK_API_KEY 或用 --api-key")
        sys.exit(1)

    from openai import OpenAI  # 延迟导入：dry-run 不依赖 openai 包

    all_problems = load_problems(args.ids)
    total = len(all_problems)
    if total == 0:
        print("没有要测试的题（检查 --ids）")
        sys.exit(1)

    # ── 划分批次（顺序切分，保证每批内题号连续）──
    batch_size = (total + args.batches - 1) // args.batches
    batches = []
    for b in range(args.batches):
        seg = all_problems[b * batch_size:(b + 1) * batch_size]
        if seg:
            batches.append({"idx": b, "probs": seg,
                            "id_range": (seg[0]["id"], seg[-1]["id"]), "size": len(seg)})
    n_batches = len(batches)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    single = total == 1
    final_path = RESULT_DIR / (
        f"{args.model}_id{all_problems[0]['id']}_{ts}.jsonl" if single
        else f"{args.model}_all_{ts}.jsonl")

    lock = threading.Lock()
    state = {
        "batches": [{"idx": b["idx"], "id_range": b["id_range"], "size": b["size"],
                     "done": 0, "correct": 0, "empty": 0, "wrong": 0, "error": 0,
                     "status": "pending"} for b in batches],
        "total_elapsed": 0.0,
    }

    client = OpenAI(api_key=api_key, base_url=args.base_url)
    t0 = time.time()

    def run_one(prob):
        correct = prob["correctAnswer"]
        try:
            messages, text_part, img_name = build_messages(prob, with_image, args.detail)
        except FileNotFoundError as e:
            return {"id": prob["id"], "correctAnswer": correct, "modelAnswer": None,
                    "isCorrect": False, "prompt": str(e), "image": None,
                    "reasoning": "", "response": "", "error": str(e),
                    "finish_reason": "", "usage": None, "elapsed": 0.0}

        kwargs = {"model": model_name, "messages": messages}
        if args.think:
            kwargs["extra_body"] = {"thinking": {"type": "enabled"}, "reasoning_effort": "high"}
            kwargs["max_tokens"] = args.max_tokens
        else:
            kwargs["temperature"] = 0.0
            # 直接模式：文本模型给 128 即可；视觉模型即使不思考也会先输出推理，给足 4096
            kwargs["max_tokens"] = 4096 if with_image else 128

        t_req = time.time()
        reasoning = raw_answer = error_msg = finish_reason = ""
        usage = None
        try:
            resp = client.chat.completions.create(**kwargs)
            reasoning = getattr(resp.choices[0].message, "reasoning_content", None) or ""
            raw_answer = resp.choices[0].message.content or ""
            finish_reason = getattr(resp.choices[0], "finish_reason", None) or ""
            usage = extract_usage(resp)
        except Exception as e:
            error_msg = str(e)
        elapsed = time.time() - t_req

        parsed = extract_answer(raw_answer) if raw_answer else None
        is_correct = (parsed == correct) if parsed else False

        if single:
            print(f"\n{'=' * 60}")
            print(f"第 {prob['id']} 题 · 正确答案 {correct}")
            if img_name:
                print(f"图片: {img_name}")
            print(f"{'─' * 60}")
            print("【Prompt 文本】")
            print(text_part)
            print(f"{'─' * 60}")
            if reasoning:
                print("【思考过程】")
                print(reasoning)
                print(f"{'─' * 60}")
            print("【模型回复】")
            print(raw_answer or f"(空) {error_msg}")
            print(f"{'=' * 60}\n")

        return {"id": prob["id"], "correctAnswer": correct, "modelAnswer": parsed,
                "isCorrect": is_correct, "prompt": text_part, "image": img_name,
                "reasoning": reasoning, "response": raw_answer,
                "error": error_msg or None, "finish_reason": finish_reason,
                "usage": usage, "elapsed": round(elapsed, 2)}

    def run_batch(b):
        idx = b["idx"]
        with lock:
            state["batches"][idx]["status"] = "running"
        for prob in b["probs"]:
            rec = run_one(prob)
            with lock:
                with open(final_path, "a", encoding="utf-8") as jf:
                    jf.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    jf.flush()
                st = state["batches"][idx]
                st["done"] += 1
                state["total_elapsed"] += rec["elapsed"]
                if rec["error"]:
                    st["error"] += 1
                elif not rec["response"]:
                    st["empty"] += 1
                elif rec["isCorrect"]:
                    st["correct"] += 1
                else:
                    st["wrong"] += 1
        with lock:
            state["batches"][idx]["status"] = "done"

    def build_panel():
        with lock:
            snap = [dict(b) for b in state["batches"]]
            total_elapsed = state["total_elapsed"]
        done = sum(b["done"] for b in snap)
        correct = sum(b["correct"] for b in snap)
        empty = sum(b["empty"] for b in snap)
        wrong = sum(b["wrong"] for b in snap)
        error = sum(b["error"] for b in snap)
        elapsed = time.time() - t0
        lines = [f"{model_name} ({args.model}{'·图' if with_image else ''}) "
                 f"{'思考' if args.think else '直接'}模式 · {n_batches} 并发 · 共 {total} 题"]
        if done > 0:
            avg_single = total_elapsed / done
            max_remaining = max(b["size"] - b["done"] for b in snap)
            eta_str = f"预计剩余 ~{format_eta(avg_single * max_remaining)}"
        else:
            eta_str = "预计剩余 ~估算中"
        lines.append(f"总进度 {done}/{total} ({done / total * 100:.1f}%) | "
                     f"对{correct} 空{empty} 错{wrong} 误{error} | "
                     f"已用 {format_eta(elapsed)} | {eta_str}")
        disp = min(12, n_batches)
        csize = max(1, (n_batches + disp - 1) // disp)
        for g0 in range(0, n_batches, csize):
            chunk = snap[g0:g0 + csize]
            sz = sum(b["size"] for b in chunk)
            d = sum(b["done"] for b in chunk)
            lo = min(b["id_range"][0] for b in chunk)
            hi = max(b["id_range"][1] for b in chunk)
            b0 = chunk[0]["idx"] + 1
            b1 = chunk[-1]["idx"] + 1
            filled = int(BAR_W * d / sz) if sz else 0
            bar = "█" * filled + "░" * (BAR_W - filled)
            if len(chunk) == 1:
                b = chunk[0]
                status = {"pending": "等待", "running": "运行", "done": "完成"}[b["status"]]
                lines.append(f"批{b0:02d} 题{lo:02d}-{hi:02d} [{bar}] "
                             f"{b['done']}/{b['size']} {status} "
                             f"对{b['correct']}空{b['empty']}错{b['wrong']}误{b['error']}")
            else:
                c = sum(x["correct"] for x in chunk)
                e = sum(x["empty"] for x in chunk)
                w = sum(x["wrong"] for x in chunk)
                err = sum(x["error"] for x in chunk)
                lines.append(f"批{b0:02d}-{b1:02d} 题{lo:02d}-{hi:02d} [{bar}] "
                             f"{d}/{sz} 对{c}空{e}错{w}误{err}")
        return lines

    def write_panel(lines, first):
        sys.stdout.write("\033[2J\033[H" if first else "\033[H")
        for line in lines:
            sys.stdout.write(line + "\033[K\n")
        sys.stdout.flush()

    def renderer(stop_event):
        first = True
        while not stop_event.is_set():
            write_panel(build_panel(), first)
            first = False
            stop_event.wait(2.0)
        write_panel(build_panel(), first)

    stop_event = threading.Event()
    render_thread = threading.Thread(target=renderer, args=(stop_event,), daemon=True)
    render_thread.start()

    threads = []
    for b in batches:
        t = threading.Thread(target=run_batch, args=(b,), daemon=True)
        t.start()
        threads.append(t)

    try:
        for t in threads:
            t.join()
    except KeyboardInterrupt:
        stop_event.set()
        render_thread.join()
        print(f"\n\n已中断。已完成的行已逐题写入 {final_path.name}（不会丢）。")
        print("未完成的题号可用 --ids 指定后补跑。")
        sys.exit(1)

    stop_event.set()
    render_thread.join()

    with lock:
        snap = [dict(b) for b in state["batches"]]
    done = sum(b["done"] for b in snap)
    correct = sum(b["correct"] for b in snap)
    empty = sum(b["empty"] for b in snap)
    wrong = sum(b["wrong"] for b in snap)
    error = sum(b["error"] for b in snap)
    acc = correct / done * 100 if done else 0.0

    print(f"\n{'=' * 60}")
    print("测试完成")
    print(f"  完成 {done}/{total} | 正确 {correct} ({acc:.1f}%) | "
          f"空 {empty} | 错 {wrong} | 调用失败 {error}")
    print(f"  总耗时 {format_eta(time.time() - t0)}")
    sort_file_by_id(final_path)
    print(f"  结果: {final_path.name}（位于 {final_path.parent}）")


if __name__ == "__main__":
    main()
