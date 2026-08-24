import type { ReactNode } from "react";

interface TableBlock {
  type: "table";
  headers: string[];
  rows: string[][];
}

interface KeyValueBlock {
  type: "keyvalue";
  rows: { key: string; value: string }[];
}

interface ListBlock {
  type: "list";
  items: string[];
}

interface HeadingBlock {
  type: "heading";
  text: string;
}

interface TextBlock {
  type: "text";
  content: string;
}

interface PageDividerBlock {
  type: "page";
  label: string;
}

type Block = TableBlock | KeyValueBlock | ListBlock | HeadingBlock | PageDividerBlock | TextBlock;

// Đánh dấu ranh giới trang do backend chèn khi OCR PDF nhiều trang (xem ocr.py extract_text)
// — CORRECTION_SYSTEM_PROMPT ở backend/classify.py đã được yêu cầu giữ nguyên dòng này khi
// sửa OCR, hiển thị thành 1 đường phân cách rõ ràng thay vì lẫn vào giữa văn xuôi.
const PAGE_DIVIDER_RE = /^\s*-{2,}\s*Trang\s+(\d+)\s*-{2,}\s*$/i;

// Tiêu đề mục đánh số kiểu "1. THÔNG TIN CÁ NHÂN" (SUMMARY_SYSTEM_PROMPT ở classify.py yêu
// cầu DeepSeek dùng đúng dạng này) — phân biệt với 1 dòng field vô tình bắt đầu bằng số thứ
// tự (vd "1. Họ và tên: ...") nhờ 2 điều kiện: KHÔNG có dấu ":" và viết HOA toàn bộ.
const HEADING_RE = /^\s*\d+\.\s+(.+)$/;

function isHeadingLine(line: string): string | null {
  const m = HEADING_RE.exec(line.trim());
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest || rest.length > 60 || rest.includes(":")) return null;
  if (rest !== rest.toUpperCase()) return null;
  return rest;
}

const LIST_ITEM_RE = /^\s*[-•]\s+(.+)$/;

const SEPARATOR_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitCells(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

function countPipes(line: string): number {
  return (line.match(/\|/g) ?? []).length;
}

// "N. Nhãn trường / English label: giá trị" — mẫu phổ biến trên CCCD/hộ chiếu/giấy tờ hành
// chính đã qua DeepSeek sửa lại (đánh số theo đúng field gốc trên giấy tờ). Tách ở dấu ":"
// ĐẦU TIÊN vì nhãn trường không chứa ":" trong khi giá trị (địa chỉ, ngày giờ...) thì có
// thể. Giới hạn độ dài nhãn để tránh nhận nhầm 1 câu văn xuôi tình cờ có dấu ":" thành field.
const KV_LINE_RE = /^\s*(?:\d+[.)]\s*)?([^:]{1,80}):\s*(.+)$/;

function tryParseKeyValueLine(line: string): { key: string; value: string } | null {
  if (countPipes(line) > 0) return null;
  const m = KV_LINE_RE.exec(line);
  if (!m) return null;
  const key = m[1].trim();
  const value = m[2].trim();
  if (!key || !value) return null;
  return { key, value };
}

// DeepSeek bọc các giá trị cần chú ý (bất nhất, cần xác minh...) trong "**...**" (xem
// SUMMARY_SYSTEM_PROMPT ở backend/classify.py) — tô sáng để nhân viên lướt nhanh là thấy
// ngay chỗ cần để ý, không phải đọc hết từng câu mới tìm ra.
function renderInline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+?\*\*)/g);
  return parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <mark key={i} className="bg-amber-200/70 text-amber-900 rounded px-0.5 font-semibold">
          {part.slice(2, -2)}
        </mark>
      );
    }
    return part;
  });
}

// Nhận diện block bảng dạng "|" do DeepSeek chèn vào khi sửa OCR gặp nội dung dạng bảng
// (bảng điểm, danh sách thành viên hộ gia đình...) — xem CORRECTION_SYSTEM_PROMPT ở
// backend/classify.py. Chấp nhận CẢ 2 dạng: bảng Markdown chuẩn (dòng tiêu đề rồi tới dòng
// phân cách "---|---") LẪN danh sách "|" không có dòng phân cách (một số tài liệu đã xử lý
// từ TRƯỚC khi prompt yêu cầu dòng phân cách chuẩn) — coi dòng "|" đầu tiên của 1 cụm liền
// nhau là tiêu đề, các dòng "|" theo sau là dữ liệu, để không cần chạy lại OCR/AI cho các
// tài liệu cũ mới hiển thị được dạng bảng. Yêu cầu ≥2 dấu "|" mỗi dòng (tức ≥3 cột) để
// tránh nhận nhầm 1 dấu "|" lẻ xuất hiện tình cờ trong văn xuôi thành bảng.
function parseBlocks(text: string): Block[] {
  const lines = text.split("\n");
  const blocks: Block[] = [];
  let buffer: string[] = [];

  const flushText = () => {
    if (buffer.length > 0) {
      blocks.push({ type: "text", content: buffer.join("\n") });
      buffer = [];
    }
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    const pageMatch = PAGE_DIVIDER_RE.exec(line);
    if (pageMatch) {
      flushText();
      blocks.push({ type: "page", label: `Trang ${pageMatch[1]}` });
      i++;
      continue;
    }

    const heading = isHeadingLine(line);
    if (heading) {
      flushText();
      blocks.push({ type: "heading", text: heading });
      i++;
      continue;
    }

    const looksLikeHeader = countPipes(line) >= 2 && line.trim().length > 0;
    if (looksLikeHeader) {
      const following: string[] = [];
      let j = i + 1;
      while (j < lines.length && countPipes(lines[j]) >= 2 && lines[j].trim().length > 0) {
        following.push(lines[j]);
        j++;
      }
      if (following.length > 0) {
        flushText();
        const headers = splitCells(line);
        const dataLines = SEPARATOR_RE.test(following[0]) ? following.slice(1) : following;
        const rows = dataLines.map(splitCells);
        blocks.push({ type: "table", headers, rows });
        i = j;
        continue;
      }
    }

    const firstListMatch = LIST_ITEM_RE.exec(line);
    if (firstListMatch) {
      const items = [firstListMatch[1]];
      let j = i + 1;
      while (j < lines.length) {
        const m = LIST_ITEM_RE.exec(lines[j]);
        if (!m) break;
        items.push(m[1]);
        j++;
      }
      flushText();
      blocks.push({ type: "list", items });
      i = j;
      continue;
    }

    const firstKv = tryParseKeyValueLine(line);
    if (firstKv) {
      const kvRows = [firstKv];
      let j = i + 1;
      while (j < lines.length) {
        const nextKv = tryParseKeyValueLine(lines[j]);
        if (!nextKv) break;
        kvRows.push(nextKv);
        j++;
      }
      // Chỉ nhận là bảng key-value khi có ≥2 dòng liên tiếp cùng dạng — 1 dòng lẻ có dấu
      // ":" nhiều khả năng chỉ là câu văn xuôi tình cờ khớp mẫu, không phải danh sách field.
      if (kvRows.length >= 2) {
        flushText();
        blocks.push({ type: "keyvalue", rows: kvRows });
        i = j;
        continue;
      }
    }

    buffer.push(line);
    i++;
  }
  flushText();
  return blocks;
}

interface Props {
  text: string | null | undefined;
  emptyLabel: string;
  // Áp cho div bọc ngoài — nền, viền, padding, giới hạn chiều cao... do nơi gọi tự quyết
  // định (khác nhau giữa DocumentList và CaseSummary), component này chỉ lo bố cục bên trong.
  className?: string;
}

export function FormattedDocumentText({ text, emptyLabel, className }: Props) {
  if (!text || !text.trim()) {
    return (
      <div className={className}>
        <p className="whitespace-pre-wrap">{emptyLabel}</p>
      </div>
    );
  }

  const blocks = parseBlocks(text);

  return (
    <div className={className}>
      <div className="flex flex-col gap-3">
        {blocks.map((block, idx) => {
          if (block.type === "table") {
            return (
              <div key={idx} className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
                <table className="min-w-full text-xs font-sans border-collapse">
                  <thead>
                    <tr className="bg-neutral-100">
                      {block.headers.map((h, hi) => (
                        <th
                          key={hi}
                          className="px-2.5 py-1.5 text-left font-semibold text-neutral-600 border-b border-neutral-200 whitespace-nowrap"
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 1 ? "bg-neutral-50" : undefined}>
                        {row.map((cell, ci) => (
                          <td key={ci} className="px-2.5 py-1.5 border-b border-neutral-100 whitespace-nowrap">
                            {renderInline(cell)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          if (block.type === "keyvalue") {
            return (
              <div key={idx} className="overflow-x-auto rounded-lg border border-neutral-200 bg-white">
                <table className="min-w-full text-xs font-sans border-collapse">
                  <tbody>
                    {block.rows.map((row, ri) => (
                      <tr key={ri} className={ri % 2 === 1 ? "bg-neutral-50" : undefined}>
                        <td className="px-2.5 py-1.5 border-b border-neutral-100 font-semibold text-neutral-600 whitespace-nowrap align-top">
                          {row.key}
                        </td>
                        <td className="px-2.5 py-1.5 border-b border-neutral-100 align-top">
                          {renderInline(row.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          if (block.type === "list") {
            return (
              <ul key={idx} className="list-disc pl-5 flex flex-col gap-1">
                {block.items.map((item, ii) => {
                  const kv = tryParseKeyValueLine(item);
                  return (
                    <li key={ii} className="text-sm leading-relaxed">
                      {kv ? (
                        <>
                          <span className="font-semibold text-neutral-600">{kv.key}:</span>{" "}
                          {renderInline(kv.value)}
                        </>
                      ) : (
                        renderInline(item)
                      )}
                    </li>
                  );
                })}
              </ul>
            );
          }
          if (block.type === "heading") {
            return (
              <p key={idx} className="text-xs font-bold uppercase tracking-wide text-neutral-500 mt-1">
                {block.text}
              </p>
            );
          }
          if (block.type === "page") {
            return (
              <div key={idx} className="flex items-center gap-3 my-1">
                <div className="flex-1 h-px bg-neutral-200" />
                <span className="text-[11px] font-semibold text-neutral-400 uppercase tracking-wide shrink-0">
                  {block.label}
                </span>
                <div className="flex-1 h-px bg-neutral-200" />
              </div>
            );
          }
          if (!block.content.trim()) return null;
          return (
            <pre key={idx} className="whitespace-pre-wrap font-sans">
              {renderInline(block.content.trim())}
            </pre>
          );
        })}
      </div>
    </div>
  );
}
