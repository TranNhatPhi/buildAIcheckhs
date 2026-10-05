/**
 * Nhãn "Nộp lại lần N" cạnh tên khách — hồ sơ admin đã cho nộp lại (POST /cases/{id}/resubmit):
 * file lần trước đã xoá, nhân viên đang làm lại từ đầu. Lần nộp đầu không hiện gì.
 *
 * Dùng Tailwind thuần chứ không dùng Tag của adminUi: nhãn này hiện ở cả trang nhân viên lẫn
 * trang admin, hai bên phải nhìn giống nhau để nói chuyện với nhau cho khớp.
 */
export function ResubmitBadge({ round }: { round?: number | null }) {
  if (!round || round < 2) return null;
  return (
    <span
      className="inline-flex shrink-0 items-center rounded-full border border-orange-300 bg-orange-100 px-2 py-0.5 text-[11px] font-semibold text-orange-800"
      title={`Hồ sơ đang làm lại cho lần nộp thứ ${round} — file của lần trước đã xoá`}
    >
      🔁 Nộp lại lần {round}
    </span>
  );
}
