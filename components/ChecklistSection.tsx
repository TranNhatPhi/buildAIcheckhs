import type { ChecklistItemStatusDTO } from "@/lib/client-types";

interface Props {
  items: ChecklistItemStatusDTO[];
}

function groupBy(items: ChecklistItemStatusDTO[]) {
  const map = new Map<string, ChecklistItemStatusDTO[]>();
  for (const s of items) {
    const key = `${s.item.section}::${s.item.group}`;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(s);
  }
  return map;
}

export function ChecklistSection({ items }: Props) {
  const grouped = groupBy(items);
  // Số thứ tự theo đúng checklist gốc (file .md khách hàng gửi) — đánh số LIÊN TỤC xuyên
  // suốt cả checklist (không reset lại từ 1 ở mỗi nhóm), dựa theo vị trí trong mảng `items`
  // đã được backend sắp xếp đúng theo `order` (compute_checklist_summary, completeness.py).
  const numberById = new Map(items.map((s, i) => [s.item.id, i + 1]));

  return (
    <div className="flex flex-col gap-7">
      {[...grouped.entries()].map(([key, statuses]) => {
        const [section, group] = key.split("::");
        return (
          <div key={key}>
            <h3 className="text-xs font-bold uppercase tracking-wide text-indigo-600 mb-3">
              {section} — {group}
            </h3>
            <ul className="flex flex-col gap-2.5">
              {statuses.map((s) => (
                <li
                  key={s.item.id}
                  className={`flex items-start gap-3 rounded-2xl border-2 px-4 py-3 transition-colors ${
                    s.complete
                      ? "bg-green-50 border-green-200"
                      : "bg-white border-neutral-200"
                  }`}
                >
                  <span
                    className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-sm font-bold ${
                      s.complete
                        ? "bg-green-500 text-white"
                        : "bg-neutral-100 text-neutral-300 border border-neutral-300"
                    }`}
                  >
                    {s.complete ? "✓" : ""}
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-neutral-800">
                        <span className="text-neutral-400">{numberById.get(s.item.id)}.</span>{" "}
                        {s.item.nameVi}
                      </span>
                      {s.item.isOptional && (
                        <span className="text-[11px] font-medium bg-neutral-100 text-neutral-500 px-2 py-0.5 rounded-full">
                          Tuỳ chọn
                        </span>
                      )}
                      {s.requiredCount > 1 && (
                        <span className="text-[11px] font-medium bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full">
                          {s.fulfilledCount}/{s.requiredCount} đã có
                        </span>
                      )}
                    </div>
                    {s.item.note && <p className="text-xs text-neutral-500 mt-1">{s.item.note}</p>}
                    {s.item.verificationNote && (
                      <p className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2.5 py-1.5 mt-1.5">
                        🔍 <span className="font-medium">Kiểm tra:</span> {s.item.verificationNote}
                      </p>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
