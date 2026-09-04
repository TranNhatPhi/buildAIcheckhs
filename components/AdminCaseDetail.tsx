"use client";

import Link from "next/link";
import { getAdminPassword } from "@/lib/adminAuth";
import { API_URL } from "@/lib/format";
import { useHydrated } from "@/lib/useHydrated";
import { downloadFile } from "@/lib/download";
import { EL, STATUS_LABEL, STATUS_COLOR, Tag, AdminSidebar } from "@/components/adminUi";
import type { CaseDetailDTO } from "@/lib/client-types";

export function AdminCaseDetail({ data }: { data: CaseDetailDTO }) {
  // Endpoint GET /cases/{id} không cần mật khẩu admin (dùng chung với trang chính), nhưng
  // trang này vẫn nằm trong khu vực /admin — kiểm tra mềm phía client để không cho xem nếu
  // chưa đăng nhập admin, tránh việc share thẳng link này ra ngoài mà vẫn xem được.
  const hydrated = useHydrated();
  const authorized = hydrated ? !!getAdminPassword() : null;

  if (authorized === null) return null;

  if (!authorized) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ backgroundColor: EL.sidebarBgActive }}>
        <p className="text-white text-sm mb-4">Bạn cần đăng nhập Admin trước khi xem trang này.</p>
        <Link
          href="/admin"
          className="text-sm font-semibold text-white rounded px-4 py-2"
          style={{ backgroundColor: EL.primary }}
        >
          Đến trang đăng nhập Admin
        </Link>
      </div>
    );
  }

  const { case: c, checklist } = data;
  const missingRequired = checklist.items.filter((s) => !s.item.isOptional && !s.complete);
  const checklistNumberById = new Map(checklist.items.map((s, i) => [s.item.id, i + 1]));

  return (
    <div className="min-h-screen flex" style={{ backgroundColor: "#f0f2f5" }}>
      <AdminSidebar />

      <div className="flex-1 min-w-0">
        <header className="h-14 bg-white border-b border-neutral-200 flex items-center px-6">
          <p className="text-sm text-neutral-400">
            <Link href="/admin" className="hover:text-neutral-700 transition-colors">
              Quản trị
            </Link>
            <span className="mx-1.5 text-neutral-300">/</span>
            <span className="text-neutral-700 font-medium">{c.clientName}</span>
          </p>
        </header>

        <div className="p-6 flex flex-col gap-5">
          <div>
            <h1 className="text-xl font-semibold text-neutral-900">{c.clientName}</h1>
            <p className="text-sm text-neutral-500 mt-0.5">
              {c.maritalStatus === "MARRIED" ? "Đã kết hôn" : "Độc thân"}
              {c.numberOfChildren > 0 ? ` · ${c.numberOfChildren} con` : ""}
              {" · "}
              {c.skillLevel === "HIGH_SKILL" ? "High Skilled" : "Low Skilled"}
              {" · Tạo ngày "}
              {new Date(c.createdAt).toLocaleDateString("vi-VN")}
            </p>
          </div>
        <div className="grid grid-cols-2 gap-4">
          <InfoPanel
            label="Hoàn thành checklist"
            value={`${checklist.percent}%`}
            sub={`${checklist.completedRequiredItems}/${checklist.totalRequiredItems} mục bắt buộc`}
            color={checklist.percent === 100 ? EL.success : EL.primary}
          />
          <InfoPanel
            label="Cần review"
            value={String(checklist.needsReviewCount)}
            sub="tài liệu"
            color={checklist.needsReviewCount > 0 ? EL.warning : EL.info}
          />
        </div>

        {missingRequired.length > 0 && (
          <div className="bg-white rounded shadow-sm p-4" style={{ borderLeft: `3px solid ${EL.warning}` }}>
            <p className="text-xs font-semibold uppercase tracking-wide mb-2" style={{ color: EL.warning }}>
              Còn thiếu {missingRequired.length} mục bắt buộc
            </p>
            <ul className="text-sm text-neutral-600 flex flex-col gap-1">
              {missingRequired.map((s) => (
                <li key={s.item.id}>
                  {checklistNumberById.get(s.item.id)}. {s.item.nameVi}
                  {s.requiredCount > 1 && ` (${s.fulfilledCount}/${s.requiredCount} đã có)`}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500 mb-2">
            File đã nộp ({c.documents.length})
          </p>
          {c.documents.length === 0 ? (
            <p className="text-neutral-500 text-sm">Chưa nộp file nào.</p>
          ) : (
            <div className="bg-white rounded shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-neutral-50 text-left text-xs font-semibold text-neutral-500 border-b border-neutral-200">
                      <th className="px-4 py-3">Tên file</th>
                      <th className="px-4 py-3">Loại giấy tờ</th>
                      <th className="px-4 py-3">Trạng thái</th>
                      <th className="px-4 py-3">Ngày nộp</th>
                      <th className="px-4 py-3 text-right">Hành động</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {[...c.documents]
                      .sort((a, b) =>
                        a.originalFilename.localeCompare(b.originalFilename, "vi", {
                          numeric: true,
                          sensitivity: "base",
                        }),
                      )
                      .map((d) => (
                      <tr key={d.id} className="hover:bg-neutral-50 transition-colors">
                        <td className="px-4 py-3">
                          <p className="font-medium text-neutral-800 truncate max-w-xs">{d.originalFilename}</p>
                          <p className="text-xs text-neutral-400 mt-0.5">{(d.fileSizeBytes / 1024).toFixed(0)} KB</p>
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {d.matchedChecklistItem?.nameVi ?? <span className="text-neutral-300">Chưa khớp</span>}
                        </td>
                        <td className="px-4 py-3">
                          <Tag color={STATUS_COLOR[d.status]}>{STATUS_LABEL[d.status]}</Tag>
                        </td>
                        <td className="px-4 py-3 text-neutral-500 text-xs">
                          {new Date(d.uploadedAt).toLocaleDateString("vi-VN")}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <a
                              href={`${API_URL}/documents/${d.id}/file`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-xs font-semibold px-3 py-1.5 rounded bg-neutral-100 text-neutral-700 hover:bg-neutral-200 transition-colors"
                            >
                              Xem file
                            </a>
                            <button
                              onClick={() =>
                                downloadFile(`${API_URL}/documents/${d.id}/file`, d.originalFilename).catch(() =>
                                  alert("Tải file thất bại.")
                                )
                              }
                              className="text-xs font-semibold px-3 py-1.5 rounded text-white transition-colors"
                              style={{ backgroundColor: EL.primary }}
                            >
                              Tải xuống
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
        </div>
      </div>
    </div>
  );
}

function InfoPanel({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string;
  sub: string;
  color: string;
}) {
  return (
    <div className="bg-white rounded shadow-sm p-4">
      <p className="text-2xl font-bold" style={{ color }}>
        {value}
      </p>
      <p className="text-xs text-neutral-400 mt-0.5">
        {label} · {sub}
      </p>
    </div>
  );
}
