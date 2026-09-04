"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { createTimeline, splitText, stagger, utils } from "animejs";

const IntroCanvas = dynamic(() => import("@/components/IntroCanvas"), { ssr: false });

const KHOA_PHIEN = "intro-3d-da-xem";
// Chốt chặn cuối: dù kịch bản 3D hay anime.js có hỏng ở đâu thì lớp phủ vẫn phải tự biến mất.
// Không có nó, một lỗi WebGL im lặng sẽ khoá nhân viên ra ngoài ứng dụng mà không cách nào vào.
const HAN_TU_DONG_TAT = 6500;

type TrangThai = "dang-do" | "dang-chay" | "an";

function daXemTrongPhien() {
  try {
    return window.sessionStorage.getItem(KHOA_PHIEN) === "1";
  } catch {
    // Chế độ ẩn danh hoặc trình duyệt chặn lưu trữ: coi như chưa xem, chạy intro là cùng.
    return false;
  }
}

function ghiNhoDaXem() {
  try {
    window.sessionStorage.setItem(KHOA_PHIEN, "1");
  } catch {
    // Không lưu được thì thôi, intro chạy lại ở lần tải sau — không đáng để chặn luồng.
  }
}

/**
 * Màn intro chạy MỘT LẦN mỗi phiên trình duyệt: lưới khối 3D ráp lại thành dấu tick rồi lao
 * qua máy quay, chữ hiện lên theo từng ký tự.
 *
 * Đây là công cụ nhân viên dùng cả ngày nên intro bị chặn kỹ: chỉ chạy lần đầu của phiên, bỏ
 * qua được bằng click hoặc phím bất kỳ, và không chạy khi hệ điều hành bật giảm chuyển động.
 */
export function IntroOverlay() {
  const [trangThai, setTrangThai] = useState<TrangThai>("dang-do");
  const lopPhuRef = useRef<HTMLDivElement>(null);
  const tieuDeRef = useRef<HTMLHeadingElement>(null);
  const phuDeRef = useRef<HTMLParagraphElement>(null);
  const vachRef = useRef<HTMLDivElement>(null);
  const khoiChuRef = useRef<HTMLDivElement>(null);
  const dangTatRef = useRef(false);

  const ketThuc = useCallback(() => {
    if (dangTatRef.current) return;
    dangTatRef.current = true;
    ghiNhoDaXem();
    const lopPhu = lopPhuRef.current;
    if (!lopPhu) {
      setTrangThai("an");
      return;
    }
    lopPhu.style.transition = "opacity 300ms ease-out";
    lopPhu.style.opacity = "0";
    window.setTimeout(() => setTrangThai("an"), 300);
  }, []);

  // Quyết định chạy hay bỏ qua. Chạy sau khi gắn vào DOM nên phía máy chủ luôn dựng sẵn nền
  // tối: bỏ qua thì người dùng chỉ thấy đúng một khung hình tối, còn hơn là chớp trắng rồi
  // mới thấy intro nhảy vào.
  useEffect(() => {
    // Quyết định nằm trong requestAnimationFrame chứ không đặt thẳng trong thân effect: gọi
    // setState đồng bộ ở đây sẽ dựng thêm một lượt render nối đuôi (react-hooks/set-state-in-effect
    // chặn đúng chỗ này). Chờ một khung hình cũng cho trang kịp vẽ xong lần đầu.
    const khungDauTien = window.requestAnimationFrame(() => {
      const giamChuyenDong = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (giamChuyenDong || daXemTrongPhien()) {
        dangTatRef.current = true;
        setTrangThai("an");
        return;
      }
      setTrangThai("dang-chay");
    });
    return () => window.cancelAnimationFrame(khungDauTien);
  }, []);

  // Kịch bản phần chữ, chạy song song và khớp nhịp với lưới 3D trong IntroCanvas.
  useEffect(() => {
    if (trangThai !== "dang-chay") return undefined;
    const tieuDe = tieuDeRef.current;
    const phuDe = phuDeRef.current;
    const vach = vachRef.current;
    const khoiChu = khoiChuRef.current;
    if (!tieuDe || !phuDe || !vach || !khoiChu) return undefined;

    const chuTachRa = splitText(tieuDe, { chars: true });
    utils.set(chuTachRa.chars, { opacity: 0, y: "0.7em", scale: 0.86 });
    utils.set([phuDe, vach], { opacity: 0 });
    utils.set(vach, { scaleX: 0 });
    // Khối chữ để `visibility: hidden` trong HTML và chỉ mở ở ĐÂY, sau khi mọi giá trị đầu đã
    // đặt xong. Nếu để nó hiện sẵn thì có đúng một khung hình chữ đủ nét rồi mới bị kéo về 0 —
    // nhìn ra ngay như một cú nháy lỗi.
    khoiChu.style.removeProperty("visibility");

    const kichBan = createTimeline({ defaults: { ease: "outExpo" } })
      .add(
        chuTachRa.chars,
        {
          opacity: 1,
          y: "0em",
          scale: 1,
          duration: 760,
          delay: stagger(24, { from: "center" }),
        },
        250,
      )
      .add(phuDe, { opacity: [0, 1], y: [14, 0], duration: 620 }, 850)
      .add(vach, { scaleX: [0, 1], duration: 900, ease: "inOutQuad" }, 1050)
      // Chữ mờ đi đúng lúc lưới bắt đầu lao qua máy quay, để hai lớp cùng thoát một nhịp.
      .add(
        [tieuDe, phuDe, vach],
        { opacity: 0, scale: 1.06, duration: 480, ease: "inQuad" },
        2150,
      );

    const hanChot = window.setTimeout(ketThuc, HAN_TU_DONG_TAT);

    return () => {
      window.clearTimeout(hanChot);
      kichBan.revert();
      chuTachRa.revert();
    };
  }, [trangThai, ketThuc]);

  // Bỏ qua bằng thao tác bất kỳ.
  useEffect(() => {
    if (trangThai !== "dang-chay") return undefined;
    const khiBamPhim = () => ketThuc();
    window.addEventListener("pointerdown", khiBamPhim);
    window.addEventListener("keydown", khiBamPhim);
    return () => {
      window.removeEventListener("pointerdown", khiBamPhim);
      window.removeEventListener("keydown", khiBamPhim);
    };
  }, [trangThai, ketThuc]);

  if (trangThai === "an") return null;

  return (
    <div
      ref={lopPhuRef}
      id="intro-lop-phu"
      className="fixed inset-0 z-[60] flex items-end justify-center overflow-hidden bg-slate-950"
    >
      {trangThai === "dang-chay" && (
        <div className="absolute inset-0">
          <IntroCanvas khiXong={ketThuc} />
        </div>
      )}
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_50%_38%,transparent_18%,rgba(2,6,23,0.78)_72%)]" />
      {/* Lưới 3D sáng và rối, chữ trắng đặt thẳng lên trên đọc rất mệt — phủ thêm một dải tối
          dưới đáy đúng chỗ khối chữ nằm. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-2/5 bg-gradient-to-t from-slate-950 via-slate-950/85 to-transparent" />

      <div ref={khoiChuRef} className="relative z-10 px-6 pb-[14vh] text-center" style={{ visibility: "hidden" }}>
        <h1
          ref={tieuDeRef}
          className="text-3xl font-bold tracking-tight text-white sm:text-5xl md:text-6xl"
        >
          Checklist Hồ Sơ Canada
        </h1>
        <p ref={phuDeRef} className="mt-4 text-sm text-indigo-200 sm:text-base">
          Đọc giấy tờ bằng AI · Tự phân loại vào checklist · Báo ngay còn thiếu gì
        </p>
        <div
          ref={vachRef}
          className="mx-auto mt-7 h-px w-56 origin-left bg-gradient-to-r from-transparent via-cyan-300 to-transparent"
        />
      </div>

      {trangThai === "dang-chay" && (
        <button
          type="button"
          onClick={ketThuc}
          className="absolute bottom-7 right-7 z-10 rounded-full border border-white/15 bg-white/5 px-4 py-1.5 text-xs text-slate-300 backdrop-blur-sm transition hover:border-white/30 hover:text-white"
        >
          Bỏ qua
        </button>
      )}

      {/* Không có JavaScript thì lớp phủ này sẽ nằm lại che kín ứng dụng — ẩn hẳn nó đi. */}
      <noscript>
        <style>{`#intro-lop-phu{display:none}`}</style>
      </noscript>
    </div>
  );
}
