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

export function CaseSummary({ items }: Props) {
  // Chỉ hiện mục ĐÃ có ít nhất 1 file khớp — đây là trang tổng hợp thông tin khách ĐÃ GỬI,
  // khác với trang checklist chính (hiện cả mục còn thiếu).
  const itemsWithDocs = items.filter((s) => s.matchedDocuments.length > 0);

  if (itemsWithDocs.length === 0) {
    return (
      <p className="text-neutral-500">
        Chưa có file nào được phân loại — chưa có thông tin để tổng hợp.
      </p>
    );
  }

  const grouped = groupBy(itemsWithDocs);

  return (
    <div className="flex flex-col gap-7">
      {[...grouped.entries()].map(([key, statuses]) => {
        const [section, group] = key.split("::");
        return (
          <div key={key}>
            <h3 className="text-xs font-bold uppercase tracking-wide text-indigo-600 mb-3">
              {section === "A" ? "Hồ sơ đương đơn" : "Hồ sơ người phụ thuộc"} — {group}
            </h3>
            <div className="flex flex-col gap-4">
              {statuses.map((s) => (
                <div key={s.item.id}>
                  <h4 className="text-sm font-semibold text-neutral-800 mb-2">{s.item.nameVi}</h4>
                  <div className="flex flex-col gap-2">
                    {s.matchedDocuments.map((doc) => {
                      const text = doc.correctedText || doc.ocrText;
                      return (
                        <div key={doc.id} className="border-2 border-neutral-200 rounded-xl p-3.5 bg-white">
                          <div className="flex items-center gap-2 mb-2">
                            <p className="text-xs font-semibold text-neutral-500 truncate">
                              {doc.originalFilename}
                            </p>
                            {doc.isManualOverride && (
                              <span className="text-[11px] font-medium bg-blue-50 text-blue-700 px-2 py-0.5 rounded-full shrink-0">
                                đã chỉnh tay
                              </span>
                            )}
                          </div>
                          <pre className="text-sm whitespace-pre-wrap font-sans text-neutral-700 leading-relaxed">
                            {text || "(không đọc được nội dung text từ file này)"}
                          </pre>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
