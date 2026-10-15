"use client";

import { useState } from "react";
import { adminFetch } from "@/lib/adminApi";
import {
  APPLICATION_STATUS_HEX_COLOR,
  getApplicationStatus,
  MAX_SUBMISSION_ROUND,
  RESUBMIT_FROM_STATUSES,
  statusChangeBlockedReason,
  statusOptionsFor,
} from "@/lib/application-status";
import type { ApplicationStatus, CaseListItemDTO } from "@/lib/client-types";

const NOP_LAI = "__NOP_LAI__";

/**
 * Ô đổi trạng thái hồ sơ của ADMIN (kèm "Nộp lại lần N"). Từ 14/10/2026 nằm ở trang CHI TIẾT HỒ SƠ admin
 * (/admin/cases/[id], nút "Xem") — bảng tổng quan chỉ hiện nhãn, không cho đổi (admin yêu cầu: tránh lỡ tay).
 * Quy tắc chặn chuyển (statusChangeBlockedReason) + backend kiểm tra lại y hệt.
 * `onDaDoi(thongBao)` gọi sau khi đổi thành công — nơi dùng tải lại danh sách; `thongBao` = câu báo đã gửi
 * email (nếu backend có gửi), null nếu không.
 */
export function AdminStatusSelect({
  c,
  onDaDoi,
}: {
  c: Pick<CaseListItemDTO, "id" | "clientName" | "applicationStatus" | "percent" | "submissionRound">;
  onDaDoi: (thongBao: string | null) => void | Promise<void>;
}) {
  const [dang, setDang] = useState(false);

  async function doiTrangThai(trangThai: ApplicationStatus) {
    if (trangThai === c.applicationStatus) return;
    setDang(true);
    try {
      const res = await adminFetch(`/cases/${c.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ applicationStatus: trangThai }),
      }).catch(() => null);
      if (!res || !res.ok) {
        // Backend trả lý do cụ thể khi vi phạm quy tắc (vd "chỉ hồ sơ Hoàn thành mới chuyển cho admin").
        const chiTiet = res ? (await res.json().catch(() => null))?.detail : null;
        alert(chiTiet ?? "Không đổi được trạng thái — thử lại sau.");
        return;
      }
      const kq = await res.json().catch(() => null);
      // Backend tự quyết trạng thái nào gửi email (INSTANT_EMAIL_STATUSES) — chỉ báo lại.
      await onDaDoi(
        kq?.statusEmailQueued
          ? `Đã chuyển "${c.clientName}" sang "${getApplicationStatus(trangThai).label}" — đã gửi email báo.`
          : null,
      );
    } finally {
      setDang(false);
    }
  }

  // "Nộp lại lần N": không phải trạng thái mà là thao tác xoá hết file + đưa hồ sơ về đầu — đi endpoint riêng
  // và phải hỏi lại, vì file đã xoá là không lấy lại được.
  async function nopLai() {
    const lan = (c.submissionRound ?? 1) + 1;
    if (
      !confirm(
        `Nộp lại lần ${lan} cho hồ sơ "${c.clientName}"?\n\n` +
          "• XOÁ VĨNH VIỄN toàn bộ file đã nộp — không khôi phục được\n" +
          "• Xoá số dư tiết kiệm và bản phân tích AI\n" +
          `• Hồ sơ về "Chờ tiếp nhận" (0%), hiện nhãn "Nộp lại lần ${lan}" — nhân viên làm lại từ đầu ở trang checklist`,
      )
    )
      return;
    setDang(true);
    try {
      const res = await adminFetch(`/cases/${c.id}/resubmit`, { method: "POST" }).catch(() => null);
      if (!res || !res.ok) {
        const chiTiet = res ? (await res.json().catch(() => null))?.detail : null;
        alert(chiTiet ?? "Không chuyển nộp lại được — thử lại sau.");
        return;
      }
      await onDaDoi(null);
    } finally {
      setDang(false);
    }
  }

  return (
    <select
      value={c.applicationStatus}
      disabled={dang}
      onChange={(e) => (e.target.value === NOP_LAI ? nopLai() : doiTrangThai(e.target.value as ApplicationStatus))}
      className="text-xs font-semibold rounded px-2 py-1 border bg-white disabled:opacity-50 cursor-pointer"
      style={{
        color: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
        borderColor: APPLICATION_STATUS_HEX_COLOR[c.applicationStatus],
      }}
      title="Đổi trạng thái hồ sơ"
    >
      {statusOptionsFor("admin", c.applicationStatus).map((st) => {
        const lyDo = statusChangeBlockedReason(st.value, c.applicationStatus, c.percent, true);
        return (
          <option key={st.value} value={st.value} disabled={!!lyDo} style={{ color: lyDo ? "#9ca3af" : "#111827" }}>
            {st.label}
            {lyDo ? ` (${lyDo})` : ""}
          </option>
        );
      })}
      {/* Đã nộp lần 2 thì không còn lựa chọn này — không có lần nộp thứ 3. */}
      {/* "Nộp lại" CHỈ sau khi rớt (15/10/2026) — trạng thái khác hiện MỜ, không chọn được. */}
      {(c.submissionRound ?? 1) < MAX_SUBMISSION_ROUND && (
        <option
          value={NOP_LAI}
          disabled={!RESUBMIT_FROM_STATUSES.includes(c.applicationStatus)}
          style={{ color: RESUBMIT_FROM_STATUSES.includes(c.applicationStatus) ? "#C2410C" : "#9ca3af" }}
        >
          🔁 Nộp lại lần {(c.submissionRound ?? 1) + 1}
          {RESUBMIT_FROM_STATUSES.includes(c.applicationStatus) ? "" : " (chỉ sau khi Không thành công)"}
        </option>
      )}
    </select>
  );
}
