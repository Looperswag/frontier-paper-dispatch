"use client";

// Phase 3 接入：基于当前论文原文+概要做满上下文问答（不做 RAG）。此处先放电报机外形占位。
export default function ChatPanel() {
  return (
    <>
      <div className="tele-head">◊ 电报问询 · Inquiry</div>
      <div className="tele-body">
        <p className="tele-stub">
          基于你正在读的这篇论文（原文 + 概要 + 你的批注）做二次问答。
        </p>
        <p className="tele-stub">—— Phase 3 接入中 ——</p>
      </div>
      <div className="tele-input">
        <input disabled placeholder="问点什么…（Phase 3 开放）" />
      </div>
    </>
  );
}
