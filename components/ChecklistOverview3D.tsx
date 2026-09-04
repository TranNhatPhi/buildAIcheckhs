import { DocumentScene3D } from "@/components/DocumentScene3D";

type Props = {
  tongHoSo: number;
  daHoanThanh: number;
  canXemLai: number;
  tienDoTrungBinh: number;
};

export function ChecklistOverview3D({
  tongHoSo,
  daHoanThanh,
  canXemLai,
  tienDoTrungBinh,
}: Props) {
  return (
    <section className="relative mb-6 grid min-h-64 overflow-hidden rounded-3xl bg-slate-950 text-white shadow-xl shadow-indigo-950/10 md:grid-cols-[1.05fr_0.95fr]">
      <div className="relative z-10 flex flex-col justify-center px-6 py-7 md:px-8">
        <div className="mb-3 flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-cyan-300 shadow-[0_0_14px_rgba(103,232,249,0.9)]" />
          <span className="text-xs font-bold uppercase tracking-[0.2em] text-indigo-200">
            Không gian hồ sơ 3D
          </span>
        </div>
        <h2 className="max-w-md text-2xl font-bold leading-tight md:text-3xl">
          Mỗi giấy tờ vào đúng vị trí, cả hồ sơ tiến gần hơn tới hoàn tất.
        </h2>
        <p className="mt-3 max-w-lg text-sm leading-relaxed text-slate-300">
          Mô hình tài liệu chuyển động phản ánh nhịp xử lý chung. Di chuột trên vùng 3D để
          quan sát các lớp hồ sơ từ nhiều góc.
        </p>

        <dl className="mt-6 grid grid-cols-3 gap-2">
          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 backdrop-blur-sm">
            <dt className="text-[11px] text-slate-400">Tổng hồ sơ</dt>
            <dd className="mt-1 text-xl font-bold">{tongHoSo}</dd>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 backdrop-blur-sm">
            <dt className="text-[11px] text-slate-400">Đã hoàn tất</dt>
            <dd className="mt-1 text-xl font-bold text-emerald-300">{daHoanThanh}</dd>
          </div>
          <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-3 backdrop-blur-sm">
            <dt className="text-[11px] text-slate-400">Cần xem lại</dt>
            <dd className="mt-1 text-xl font-bold text-amber-300">{canXemLai}</dd>
          </div>
        </dl>
      </div>

      <div className="relative min-h-56 md:min-h-full">
        <DocumentScene3D cheDo="tong-quan" tienDo={tienDoTrungBinh} className="absolute inset-0" />
        <div className="pointer-events-none absolute bottom-4 left-1/2 z-10 w-[min(78%,18rem)] -translate-x-1/2 rounded-full border border-white/10 bg-slate-950/55 px-3 py-2 backdrop-blur-md">
          <div className="flex items-center justify-between text-[11px] text-slate-300">
            <span>Tiến độ trung bình</span>
            <strong className="text-white">{tienDoTrungBinh}%</strong>
          </div>
          <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-gradient-to-r from-cyan-300 to-indigo-400 transition-[width] duration-700"
              style={{ width: `${tienDoTrungBinh}%` }}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
