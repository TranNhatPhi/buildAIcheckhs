"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { API_URL } from "@/lib/format";

export function NewCaseForm() {
  const router = useRouter();
  const [clientName, setClientName] = useState("");
  const [maritalStatus, setMaritalStatus] = useState<"SINGLE" | "MARRIED">("SINGLE");
  const [numberOfChildren, setNumberOfChildren] = useState(0);
  const [skillLevel, setSkillLevel] = useState<"LOW_SKILL" | "HIGH_SKILL">("LOW_SKILL");
  const [partner, setPartner] = useState("");
  // Danh sách đối tác đã từng nhập, dùng làm gợi ý. Không có bảng Partner riêng nên đây
  // là thứ duy nhất kéo mọi người gõ giống nhau thay vì đẻ ra "LNC HN" / "LNC Hà Nội".
  const [partnerSuggestions, setPartnerSuggestions] = useState<string[]>([]);
  const [notes, setNotes] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Gợi ý hỏng thì ô vẫn gõ tay được bình thường — không báo lỗi, không chặn tạo hồ sơ.
    fetch(`${API_URL}/cases/partners`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setPartnerSuggestions)
      .catch(() => {});
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch(`${API_URL}/cases`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientName,
          maritalStatus,
          numberOfChildren,
          skillLevel,
          partner,
          notes,
        }),
      });

      if (!res.ok) {
        setError("Không tạo được hồ sơ. Kiểm tra lại thông tin.");
        return;
      }

      const created = await res.json();
      router.push(`/cases/${created.id}`);
    } catch {
      setError("Không kết nối được máy chủ. Vui lòng thử lại.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="flex flex-col gap-6 bg-white border-2 border-neutral-200 rounded-2xl p-7 shadow-sm"
    >
      <div>
        <label className="block text-sm font-semibold mb-1.5">Tên khách hàng</label>
        <input
          required
          maxLength={191}
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
          className="w-full border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
          placeholder="Nguyễn Văn A"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">
          Đối tác / nguồn <span className="font-normal text-neutral-400">(tuỳ chọn)</span>
        </label>
        <input
          list="danh-sach-doi-tac"
          maxLength={191}
          value={partner}
          onChange={(e) => setPartner(e.target.value)}
          className="w-full border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
          placeholder="Ví dụ: Công ty ABC"
        />
        {/* datalist = gõ tự do NHƯNG có gợi ý các đối tác đã nhập trước đó. Chọn lại từ gợi
            ý giúp tên viết giống nhau, nhờ vậy bộ lọc ở danh sách hồ sơ mới gom đúng nhóm. */}
        <datalist id="danh-sach-doi-tac">
          {partnerSuggestions.map((name) => (
            <option key={name} value={name} />
          ))}
        </datalist>
        <p className="mt-1.5 text-xs text-neutral-400">
          Dùng để phân biệt khi hai đối tác có khách trùng tên, và để lọc hồ sơ theo nguồn.
        </p>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">Tình trạng hôn nhân</label>
        <div className="flex gap-3">
          <label
            className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
              maritalStatus === "SINGLE"
                ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                : "border-neutral-200 text-neutral-500"
            }`}
          >
            <input
              type="radio"
              className="hidden"
              checked={maritalStatus === "SINGLE"}
              onChange={() => setMaritalStatus("SINGLE")}
            />
            Độc thân
          </label>
          <label
            className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
              maritalStatus === "MARRIED"
                ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                : "border-neutral-200 text-neutral-500"
            }`}
          >
            <input
              type="radio"
              className="hidden"
              checked={maritalStatus === "MARRIED"}
              onChange={() => setMaritalStatus("MARRIED")}
            />
            Đã kết hôn
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">Trình độ kỹ năng (skill)</label>
        <div className="flex gap-3">
          <label
            className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
              skillLevel === "LOW_SKILL"
                ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                : "border-neutral-200 text-neutral-500"
            }`}
          >
            <input
              type="radio"
              className="hidden"
              checked={skillLevel === "LOW_SKILL"}
              onChange={() => setSkillLevel("LOW_SKILL")}
            />
            Low Skilled
          </label>
          <label
            className={`flex items-center gap-2 text-sm font-medium px-4 py-2 rounded-full border-2 cursor-pointer transition-colors ${
              skillLevel === "HIGH_SKILL"
                ? "border-indigo-400 bg-indigo-50 text-indigo-700"
                : "border-neutral-200 text-neutral-500"
            }`}
          >
            <input
              type="radio"
              className="hidden"
              checked={skillLevel === "HIGH_SKILL"}
              onChange={() => setSkillLevel("HIGH_SKILL")}
            />
            High Skilled
          </label>
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">Số con</label>
        <input
          type="number"
          min={0}
          max={20}
          value={numberOfChildren}
          onChange={(e) => setNumberOfChildren(Number(e.target.value))}
          className="w-32 border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold mb-1.5">Ghi chú (tuỳ chọn)</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="w-full border-2 border-neutral-200 rounded-xl px-4 py-2.5 text-sm focus:border-indigo-400 focus:outline-none transition-colors"
        />
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="bg-indigo-600 text-white px-6 py-3 rounded-full text-sm font-semibold hover:bg-indigo-700 disabled:opacity-50 self-start shadow-sm transition-colors"
      >
        {submitting ? "Đang tạo..." : "Tạo hồ sơ"}
      </button>
    </form>
  );
}
