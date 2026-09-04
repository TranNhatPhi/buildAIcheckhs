"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createTimeline, onScroll, stagger, utils } from "animejs";
// Import CÓ TÁC DỤNG PHỤ: nạp module này thì anime.js mới tự đăng ký adapter Three.js. Thiếu
// nó, animate() ghi thẳng vào .x/.y/.z của instance mà không bao giờ cập nhật ma trận, nên
// cảnh đứng im hoàn toàn và KHÔNG báo lỗi gì. Xem thêm ghi chú ở components/IntroCanvas.jsx.
import { getInstances } from "animejs/adapters/three";

const COT = 23;
const HANG = 20;
const BUOC = 0.62;
const CANH_O = 0.44;
const SO_O = COT * HANG;

// Dấu tick ở cảnh cuối, ghi bằng đơn vị thế giới của three.js (không phải toạ độ lưới chuẩn
// hoá — lưới rộng hơn cao nên toạ độ chuẩn hoá làm hình bị kéo bè, đã sửa một lần ở IntroCanvas).
const DOAN_TICK = [
  [-3.0, 0.6, -0.3, -1.8],
  [-0.3, -1.8, 3.4, 3.6],
];
const DAY_TICK = 0.62;

const BAN_KINH_VONG = [5.4, 5.95]; // hai vòng đồng tâm ở cảnh cuối
const SO_O_MOI_VONG = 55;
const DICH_LEN = 1.7; // đẩy cảnh lên trên, chừa dải dưới cho khối chữ

const MAU_NGUOI = new THREE.Color(0x4f46e5); // chàm
const MAU_LO = new THREE.Color(0x22d3ee); // lơ
const MAU_TICK = new THREE.Color(0x34d399); // lục — dấu ✓
const MAU_BUI = new THREE.Color(0x1e1b4b); // chàm rất tối — lớp bụi nền ở cảnh cuối

// Hàm băm tất định thay cho Math.random: mọi lần tải đều ra cùng một bố cục nên lỗi hiển thị
// tái hiện được, còn mắt vẫn thấy là ngẫu nhiên.
function bam(hat) {
  const v = Math.sin(hat * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function khoangCachToiDoan(x, y, doan) {
  const [x1, y1, x2, y2] = doan;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function laOTick(x, y) {
  return DOAN_TICK.some((doan) => khoangCachToiDoan(x, y, doan) < DAY_TICK);
}

/**
 * Cảnh 3D chuyển theo thao tác cuộn trang, gồm ba hình thái của CÙNG một tập khối:
 *
 *   1. Giấy tờ rời rạc trôi lộn xộn trong không gian
 *   2. Xếp phẳng thành mặt bàn tài liệu, có vạch quét chạy qua
 *   3. Mọi khối dạt ra thành vòng, để lộ dấu ✓ ở giữa
 *
 * Tiến trình timeline buộc thẳng vào vị trí cuộn bằng `onScroll({ sync })` của anime.js, nên
 * kéo tới đâu cảnh đi tới đó, kéo ngược lại thì lùi lại — không phải một đoạn phim tự chạy.
 *
 * Phân chia quyền ghi, đừng phá: anime.js giữ toàn bộ phép biến hình của từng khối và độ sâu
 * cả nhóm; vòng lặp vẽ chỉ lo xoay nhóm, vạch quét và MÀU. Hai bên cùng ghi một thuộc tính
 * là hình giật.
 */
export default function CanhCuonCanvas({ khungCuonRef }) {
  const khungRef = useRef(null);

  useEffect(() => {
    const khung = khungRef.current;
    const khungCuon = khungCuonRef?.current;
    if (!khung || !khungCuon) return undefined;

    const thietBiYeu = (window.navigator.hardwareConcurrency || 0) <= 4;
    const giamChuyenDong = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let boDung;
    try {
      boDung = new THREE.WebGLRenderer({ alpha: true, antialias: !thietBiYeu });
    } catch {
      return undefined;
    }

    boDung.setPixelRatio(Math.min(window.devicePixelRatio || 1, thietBiYeu ? 1 : 1.5));
    boDung.outputColorSpace = THREE.SRGBColorSpace;
    boDung.domElement.style.display = "block";
    boDung.domElement.style.width = "100%";
    boDung.domElement.style.height = "100%";
    khung.appendChild(boDung.domElement);

    const canh = new THREE.Scene();
    const mayAnh = new THREE.PerspectiveCamera(38, 1, 0.1, 90);

    canh.add(new THREE.HemisphereLight(0xc7d2fe, 0x0b1020, 2.2));
    const denChinh = new THREE.DirectionalLight(0xffffff, 2.4);
    denChinh.position.set(5, 7, 10);
    canh.add(denChinh);
    const denPhu = new THREE.PointLight(0x22d3ee, 22, 34);
    denPhu.position.set(-7, -4, 8);
    canh.add(denPhu);

    const nhom = new THREE.Group();
    canh.add(nhom);

    const hinhO = new RoundedBoxGeometry(CANH_O, CANH_O, CANH_O, 2, 0.1);
    const vatLieu = new THREE.MeshStandardMaterial({ roughness: 0.36, metalness: 0.2 });
    const luoi = new THREE.InstancedMesh(hinhO, vatLieu, SO_O);
    luoi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nhom.add(luoi);

    // ---- Dựng sẵn ba hình thái cho từng khối ----
    const canh1 = new Array(SO_O); // mây giấy tờ rời
    const canh2 = new Array(SO_O); // mặt phẳng
    const canh3 = new Array(SO_O); // vòng + dấu tick
    const laTick = new Array(SO_O);
    const chiSoNgoaiTick = [];

    for (let hang = 0; hang < HANG; hang += 1) {
      for (let cot = 0; cot < COT; cot += 1) {
        // Thứ tự hàng-trước-cột-sau phải khớp grid [COT, HANG] của stagger bên dưới.
        const i = hang * COT + cot;
        const x = (cot - (COT - 1) / 2) * BUOC;
        const y = ((HANG - 1) / 2 - hang) * BUOC;

        canh2[i] = { x, y, z: 0 };
        canh1[i] = {
          x: (bam(i * 3.1) - 0.5) * 15.5,
          y: (bam(i * 5.7 + 9) - 0.5) * 11.5,
          z: (bam(i * 7.3 + 21) - 0.5) * 11,
          rotateX: (bam(i * 2.2 + 4) - 0.5) * 3.2,
          rotateY: (bam(i * 4.4 + 8) - 0.5) * 3.2,
          rotateZ: (bam(i * 6.6 + 12) - 0.5) * 3.2,
        };

        laTick[i] = laOTick(x, y);
        if (!laTick[i]) chiSoNgoaiTick.push(i);
      }
    }

    for (let i = 0; i < SO_O; i += 1) {
      // Khối thuộc dấu tick ĐỨNG YÊN ở cảnh cuối — chính vì mọi khối khác dạt đi mà dấu ✓ hiện
      // ra, chứ không phải nó được vẽ thêm vào.
      if (laTick[i]) canh3[i] = { ...canh2[i], z: 0.35, tyLe: 1.18 };
    }
    chiSoNgoaiTick.forEach((i, thuTu) => {
      if (thuTu < BAN_KINH_VONG.length * SO_O_MOI_VONG) {
        const vong = Math.floor(thuTu / SO_O_MOI_VONG);
        const goc = ((thuTu % SO_O_MOI_VONG) / SO_O_MOI_VONG) * Math.PI * 2;
        const r = BAN_KINH_VONG[vong];
        canh3[i] = { x: Math.cos(goc) * r, y: Math.sin(goc) * r, z: 0, tyLe: 0.92 };
      } else {
        // Phần còn lại thành lớp bụi mờ ở xa, giữ chiều sâu cho khung hình.
        const goc = bam(i * 11.9) * Math.PI * 2;
        const nghieng = Math.acos(2 * bam(i * 13.7 + 3) - 1);
        const r = 8.5 + bam(i * 17.3 + 5) * 4;
        canh3[i] = {
          x: Math.sin(nghieng) * Math.cos(goc) * r,
          y: Math.sin(nghieng) * Math.sin(goc) * r * 0.7,
          z: Math.cos(nghieng) * r * 0.6 - 3,
          tyLe: 0.34,
        };
      }
    });

    // ---- Vạch quét của cảnh 2 ----
    const vatLieuVach = new THREE.MeshBasicMaterial({
      color: 0x67e8f9,
      transparent: true,
      opacity: 0,
    });
    const vachQuet = new THREE.Mesh(new THREE.PlaneGeometry(COT * BUOC, 0.14), vatLieuVach);
    vachQuet.position.z = 0.5;
    nhom.add(vachQuet);

    const o = getInstances(luoi);

    utils.set(o, {
      x: (muc, i) => canh1[i].x,
      y: (muc, i) => canh1[i].y,
      z: (muc, i) => canh1[i].z,
      rotateX: (muc, i) => canh1[i].rotateX,
      rotateY: (muc, i) => canh1[i].rotateY,
      rotateZ: (muc, i) => canh1[i].rotateZ,
      scale: 1,
    });

    const lanTuTam = (buoc) => stagger(buoc, { grid: [COT, HANG], from: "center" });

    // Nửa đầu tiến trình: mây giấy gom lại thành mặt phẳng. Nửa sau: dạt ra để lộ dấu ✓.
    // `sync` buộc tiến trình vào vị trí cuộn; con số là độ trễ làm mượt, 0 là bám cứng từng
    // pixel (giật theo bánh xe chuột), 1 là trôi nổi chậm chạp.
    const kichBan = createTimeline({
      defaults: { ease: "inOutQuad" },
      autoplay: giamChuyenDong
        ? false
        : onScroll({
            target: khungCuon,
            enter: "top top",
            leave: "bottom bottom",
            sync: 0.28,
          }),
    })
      .add(
        o,
        {
          x: (muc, i) => canh2[i].x,
          y: (muc, i) => canh2[i].y,
          z: (muc, i) => canh2[i].z,
          rotateX: 0,
          rotateY: 0,
          rotateZ: 0,
          scale: 1,
          duration: 400,
          delay: lanTuTam(1.6),
        },
        0,
      )
      // Cảnh 3 bắt đầu ở 600 chứ không phải 400: khoảng trống 400→600 là nhịp DỪNG để mặt
      // phẳng đứng yên một lúc cho vạch quét chạy qua. Nối đuôi liền mạch thì cảnh 2 chỉ tồn
      // tại đúng một khoảnh khắc, người cuộn không kịp nhận ra đã có một mặt phẳng.
      .add(
        o,
        {
          x: (muc, i) => canh3[i].x,
          y: (muc, i) => canh3[i].y,
          z: (muc, i) => canh3[i].z,
          scale: (muc, i) => canh3[i].tyLe,
          duration: 400,
          delay: lanTuTam(1.1),
        },
        600,
      )
      .add(
        nhom,
        { z: [{ to: 0, duration: 400 }, { to: 0, duration: 200 }, { to: -1.2, duration: 400 }] },
        0,
      );

    // Máy bật giảm chuyển động: bỏ hẳn phần cuộn, hiện thẳng cảnh cuối (dấu ✓) cho đủ nghĩa.
    if (giamChuyenDong) kichBan.seek(kichBan.duration);

    // ---- Màu và vạch quét: do vòng lặp vẽ lo, đọc tiến trình từ timeline ----
    const mau = new THREE.Color();
    let mauDaVe = -1;

    function capNhatMau(tienTrinh) {
      if (Math.abs(tienTrinh - mauDaVe) < 0.002) return;
      mauDaVe = tienTrinh;
      // Chỉ đổi màu ở nửa sau, đúng lúc các khối bắt đầu dạt ra.
      const pha = Math.max(0, Math.min(1, (tienTrinh - 0.45) / 0.3));
      for (let i = 0; i < SO_O; i += 1) {
        const goc = MAU_NGUOI.clone().lerp(MAU_LO, (i % COT) / (COT - 1));
        const dich = laTick[i] ? MAU_TICK : canh3[i].tyLe < 0.5 ? MAU_BUI : MAU_LO;
        mau.copy(goc).lerp(dich, pha);
        luoi.setColorAt(i, mau);
      }
      luoi.instanceColor.needsUpdate = true;
    }

    function capNhatVach(tienTrinh) {
      // Vạch quét chỉ có nghĩa quanh lúc mặt phẳng vừa thành hình (giữa cảnh 1 và cảnh 2).
      const manh = Math.max(0, 1 - Math.abs(tienTrinh - 0.5) / 0.22);
      vatLieuVach.opacity = manh * 0.9;
      vachQuet.position.y = (0.5 - tienTrinh) * (HANG * BUOC) * 2.2;
    }

    const dongHo = new THREE.Clock();
    let dangTrongKhung = true;
    let dangChay = false;

    function doiKichThuoc() {
      const rong = Math.max(1, khung.clientWidth);
      const cao = Math.max(1, khung.clientHeight);
      mayAnh.aspect = rong / cao;
      const nuaGoc = Math.tan((mayAnh.fov * Math.PI) / 360);
      // Đẩy cả cảnh lên trên để dải dưới dành cho khối chữ. Không dịch thì dấu ✓ ở cảnh cuối
      // nằm đúng sau dòng tiêu đề, mất cả hình lẫn chữ.
      nhom.position.y = DICH_LEN;
      // Lùi đủ xa để CẢ mặt phẳng ở cảnh 2 lẫn vòng ngoài ở cảnh 3 đều nằm trọn khung hình
      // (đã tính cả phần dịch lên); thiếu một trong hai là có cảnh bị cắt mất rìa.
      const canCao = Math.max(((HANG * BUOC) / 2) * 1.06, BAN_KINH_VONG[1]) + DICH_LEN;
      const canRong = Math.max(((COT * BUOC) / 2) * 1.06, BAN_KINH_VONG[1] + CANH_O);
      mayAnh.position.z = Math.max(canCao / nuaGoc, canRong / (nuaGoc * mayAnh.aspect));
      mayAnh.updateProjectionMatrix();
      boDung.setSize(rong, cao, false);
      boDung.render(canh, mayAnh);
    }

    function ve() {
      const thoiGian = dongHo.getElapsedTime();
      const tienTrinh = kichBan.progress;
      capNhatMau(tienTrinh);
      capNhatVach(tienTrinh);
      // Chỉ chạm vào cả NHÓM, không chạm vào từng khối — anime.js đang giữ chúng.
      nhom.rotation.y = Math.sin(thoiGian * 0.18) * 0.09 + (tienTrinh - 0.5) * 0.22;
      nhom.rotation.x = Math.sin(thoiGian * 0.13) * 0.05;
      boDung.render(canh, mayAnh);
    }

    function batDauVe() {
      if (dangChay || !dangTrongKhung || document.hidden) return;
      dangChay = true;
      boDung.setAnimationLoop(ve);
    }

    function dungVe() {
      if (!dangChay) return;
      dangChay = false;
      boDung.setAnimationLoop(null);
    }

    const theoDoiKichThuoc = new ResizeObserver(doiKichThuoc);
    const theoDoiHienThi = new IntersectionObserver(([muc]) => {
      dangTrongKhung = muc.isIntersecting;
      if (dangTrongKhung) batDauVe();
      else dungVe();
    });
    const khiDoiTab = () => (document.hidden ? dungVe() : batDauVe());

    theoDoiKichThuoc.observe(khung);
    theoDoiHienThi.observe(khung);
    document.addEventListener("visibilitychange", khiDoiTab);
    doiKichThuoc();
    capNhatMau(0);
    batDauVe();

    return () => {
      theoDoiKichThuoc.disconnect();
      theoDoiHienThi.disconnect();
      document.removeEventListener("visibilitychange", khiDoiTab);
      dungVe();
      kichBan.revert();
      hinhO.dispose();
      vatLieu.dispose();
      vachQuet.geometry.dispose();
      vatLieuVach.dispose();
      luoi.dispose();
      boDung.dispose();
      boDung.forceContextLoss();
      boDung.domElement.remove();
    };
  }, [khungCuonRef]);

  return <div ref={khungRef} className="h-full w-full" aria-hidden="true" />;
}
