"use client";

import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createTimeline, onScroll, utils } from "animejs";
import { ChecklistOverview3D } from "@/components/ChecklistOverview3D";

const CanhCuonCanvas = dynamic(() => import("@/components/CanhCuonCanvas"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-slate-950" />,
});

type Props = {
  tongHoSo: number;
  daHoanThanh: number;
  canXemLai: number;
  tienDoTrungBinh: number;
};

const CANH = [
  {
    nhan: "01 — Nhận giấy tờ",
    tieuDe: "Giấy tờ về từ mọi phía.",
    mo: "Hộ chiếu, sổ tiết kiệm, giấy tờ nhà đất, hợp đồng lao động — mỗi hồ sơ một mớ, chưa ai biết đang thiếu cái gì.",
  },
  {
    nhan: "02 — AI đọc và xếp chỗ",
    tieuDe: "Máy đọc chữ rồi tự xếp vào đúng mục.",
    mo: "OCR đọc từng trang, sửa lỗi chính tả, rồi phân loại vào đúng mục trong checklist — không phải mở từng file ra nhìn.",
  },
  {
    nhan: "03 — Biết ngay còn thiếu gì",
    tieuDe: "Đủ hay thiếu, hiện ra ngay.",
    mo: "Mục nào đã đủ, mục nào còn trống, hồ sơ nào cần xem lại — thấy hết trong một màn hình.",
  },
];

/**
 * Phần mở đầu trang danh sách: một cảnh 3D chuyển hình theo thao tác cuộn.
 *
 * Khung ngoài cao hơn màn hình, khung trong `sticky` nên trong lúc người dùng cuộn qua đoạn
 * đó thì cảnh đứng yên tại chỗ và BIẾN HÌNH — kéo tới đâu đi tới đó, kéo ngược thì lùi lại.
 * Cả phần 3D lẫn phần chữ đều buộc vào cùng một mốc cuộn (chính thẻ <section> này) bằng
 * `onScroll` của anime.js, nên hai lớp không bao giờ lệch nhau.
 *
 * Đây là công cụ nhân viên dùng cả ngày: có sẵn nút nhảy thẳng xuống danh sách, các con số
 * quan trọng luôn hiện ở đáy khung, và máy bật giảm chuyển động thì đoạn cuộn co lại còn một
 * khung tĩnh hiện thẳng cảnh cuối.
 */
export function CanhCuonHoSo(props: Props) {
  const { tongHoSo, daHoanThanh, canXemLai, tienDoTrungBinh } = props;
  const khungRef = useRef<HTMLElement>(null);
  const [khungHep, setKhungHep] = useState(false);
  const chuRef = useRef<(HTMLDivElement | null)[]>([]);
  const vachRef = useRef<HTMLDivElement>(null);

  // Cảnh ba lớp này cần một sân đủ rộng. Sidebar chiếm cứng 240px, nên dưới 768px phần nội
  // dung chỉ còn hơn 200px: ép cho vừa chiều ngang thì máy quay phải lùi xa tới mức cả cảnh
  // co lại thành một đốm. Dưới ngưỡng đó dùng thẳng hero gọn cũ.
  //
  // Đặt state trong requestAnimationFrame chứ không gọi thẳng trong thân effect
  // (react-hooks/set-state-in-effect). Mặc định coi là màn rộng vì công cụ này chỉ dùng trên
  // máy bàn — đoán sai chiều đó thì không ai thấy, đoán ngược lại thì desktop nào cũng nháy.
  useEffect(() => {
    const doDac = window.matchMedia("(max-width: 767px)");
    const capNhat = () => setKhungHep(doDac.matches);
    const khungDau = window.requestAnimationFrame(capNhat);
    doDac.addEventListener("change", capNhat);
    return () => {
      window.cancelAnimationFrame(khungDau);
      doDac.removeEventListener("change", capNhat);
    };
  }, []);

  useEffect(() => {
    if (khungHep) return undefined;
    const khungCuon = khungRef.current;
    const cacKhoiChu = chuRef.current.filter((muc): muc is HTMLDivElement => muc !== null);
    const vach = vachRef.current;
    if (!khungCuon || !vach || cacKhoiChu.length !== CANH.length) return undefined;

    const giamChuyenDong = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    if (giamChuyenDong) {
      // Không có timeline thì ba khối chữ sẽ chồng lên nhau — chỉ để lại khối cuối, khớp với
      // cảnh cuối mà bản 3D hiện thẳng trong trường hợp này.
      utils.set(cacKhoiChu.slice(0, -1), { opacity: 0 });
      utils.set(vach, { scaleX: 1 });
      return undefined;
    }

    utils.set(cacKhoiChu.slice(1), { opacity: 0, y: 22 });
    utils.set(vach, { scaleX: 0 });

    const kichBan = createTimeline({
      defaults: { ease: "inOutQuad" },
      autoplay: onScroll({
        target: khungCuon,
        enter: "top top",
        leave: "bottom bottom",
        // Cùng một mốc và cùng độ trễ làm mượt với CanhCuonCanvas, nếu lệch thì chữ và hình
        // chạy so le nhau, nhìn ra ngay.
        sync: 0.28,
      }),
    })
      .add(cacKhoiChu[0], { opacity: 0, y: -22, duration: 120 }, 250)
      .add(cacKhoiChu[1], { opacity: 1, y: 0, duration: 130 }, 300)
      .add(cacKhoiChu[1], { opacity: 0, y: -22, duration: 120 }, 620)
      .add(cacKhoiChu[2], { opacity: 1, y: 0, duration: 130 }, 670)
      .add(vach, { scaleX: 1, duration: 1000, ease: "linear" }, 0);

    return () => {
      kichBan.revert();
    };
  }, [khungHep]);

  if (khungHep) return <ChecklistOverview3D {...props} />;

  return (
    <section
      ref={khungRef}
      className="relative -mx-6 mb-8 h-[240vh] motion-reduce:h-[76vh]"
      aria-label="Giới thiệu quy trình xử lý hồ sơ"
    >
      <div className="sticky top-0 h-screen overflow-hidden bg-slate-950 motion-reduce:h-[72vh]">
        <div className="absolute inset-0">
          <CanhCuonCanvas khungCuonRef={khungRef} />
        </div>
        <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_40%,transparent_20%,rgba(2,6,23,0.72)_78%)]" />

        {/* Vạch tiến trình chạy theo vị trí cuộn, cho biết đang ở đâu trong ba cảnh. */}
        <div className="absolute inset-x-0 top-0 h-0.5 bg-white/10">
          <div
            ref={vachRef}
            className="h-full origin-left bg-gradient-to-r from-indigo-400 to-cyan-300"
          />
        </div>

        {/* Cảnh 3D sáng và rối; chữ trắng đặt thẳng lên là không đọc nổi. Phủ dải tối ở đáy,
            đúng chỗ khối chữ nằm. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-3/5 bg-gradient-to-t from-slate-950 via-slate-950/88 to-transparent" />

        <dl className="absolute right-6 top-6 grid grid-cols-2 gap-2 text-white md:grid-cols-4">
          {[
            { nhan: "Tổng hồ sơ", giaTri: tongHoSo, mau: "text-white" },
            { nhan: "Đã hoàn tất", giaTri: daHoanThanh, mau: "text-emerald-300" },
            { nhan: "Cần xem lại", giaTri: canXemLai, mau: "text-amber-300" },
            { nhan: "Tiến độ TB", giaTri: `${tienDoTrungBinh}%`, mau: "text-cyan-300" },
          ].map((muc) => (
            <div
              key={muc.nhan}
              className="rounded-xl border border-white/10 bg-slate-950/55 px-3 py-2 backdrop-blur-md"
            >
              <dt className="text-[10px] text-slate-400">{muc.nhan}</dt>
              <dd className={`mt-0.5 text-base font-bold ${muc.mau}`}>{muc.giaTri}</dd>
            </div>
          ))}
        </dl>

        <div className="absolute inset-x-0 bottom-0 px-7 pb-9 md:px-10">
          <div className="relative max-w-xl">
            {CANH.map((canh, chiSo) => (
              <div
                key={canh.nhan}
                ref={(muc) => {
                  chuRef.current[chiSo] = muc;
                }}
                className={chiSo === 0 ? "relative" : "absolute inset-x-0 bottom-0"}
              >
                <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-cyan-300">
                  {canh.nhan}
                </p>
                <h2 className="mt-3 text-2xl font-bold leading-tight text-white md:text-4xl">
                  {canh.tieuDe}
                </h2>
                <p className="mt-3 text-sm leading-relaxed text-slate-300 md:text-base">
                  {canh.mo}
                </p>
              </div>
            ))}
          </div>

          <a
            href="#danh-sach-ho-so"
            className="mt-7 inline-block rounded-full border border-white/15 bg-white/5 px-4 py-2 text-xs text-slate-200 backdrop-blur-sm transition hover:border-white/35 hover:text-white"
          >
            Xuống thẳng danh sách ↓
          </a>
        </div>
      </div>
    </section>
  );
}
