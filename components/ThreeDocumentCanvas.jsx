"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

function taoTaiLieu(mauNhan, tyLe = 1) {
  const nhom = new THREE.Group();
  const giay = new THREE.Mesh(
    new THREE.BoxGeometry(1.65 * tyLe, 2.15 * tyLe, 0.08 * tyLe),
    new THREE.MeshStandardMaterial({ color: 0xf8fafc, roughness: 0.62, metalness: 0.04 }),
  );
  nhom.add(giay);

  const vatLieuDong = new THREE.MeshBasicMaterial({ color: mauNhan, transparent: true, opacity: 0.72 });
  for (let i = 0; i < 4; i += 1) {
    const dong = new THREE.Mesh(
      new THREE.BoxGeometry((i === 3 ? 0.78 : 1.15) * tyLe, 0.055 * tyLe, 0.018 * tyLe),
      vatLieuDong,
    );
    dong.position.set(-0.12 * tyLe, (0.5 - i * 0.28) * tyLe, 0.052 * tyLe);
    nhom.add(dong);
  }

  const dauMuc = new THREE.Mesh(
    new THREE.BoxGeometry(0.28 * tyLe, 0.28 * tyLe, 0.02 * tyLe),
    new THREE.MeshBasicMaterial({ color: mauNhan }),
  );
  dauMuc.position.set(-0.5 * tyLe, 0.82 * tyLe, 0.055 * tyLe);
  nhom.add(dauMuc);
  return nhom;
}

function taoHatSang(soLuong, banKinh) {
  const viTri = new Float32Array(soLuong * 3);
  for (let i = 0; i < soLuong; i += 1) {
    const goc = i * 2.39996;
    const lop = 0.5 + ((i * 37) % 100) / 100;
    viTri[i * 3] = Math.cos(goc) * banKinh * lop;
    viTri[i * 3 + 1] = Math.sin(goc * 0.73) * banKinh * 0.62;
    viTri[i * 3 + 2] = Math.sin(goc) * banKinh * lop;
  }
  const hinh = new THREE.BufferGeometry();
  hinh.setAttribute("position", new THREE.BufferAttribute(viTri, 3));
  return new THREE.Points(
    hinh,
    new THREE.PointsMaterial({ color: 0xa5b4fc, size: 0.035, transparent: true, opacity: 0.7 }),
  );
}

export default function ThreeDocumentCanvas({ cheDo = "tong-quan", tienDo = 0 }) {
  const khungRef = useRef(null);
  const tienDoRef = useRef(tienDo);
  const capNhatTinhRef = useRef(null);

  useEffect(() => {
    tienDoRef.current = Math.min(100, Math.max(0, tienDo));
    capNhatTinhRef.current?.(tienDoRef.current);
  }, [tienDo]);

  useEffect(() => {
    const khung = khungRef.current;
    if (!khung) return undefined;

    // Khai báo NGOÀI try: `setPixelRatio` và số hạt sáng bên dưới còn đọc lại biến này. Để
    // `const` bên trong try thì nó bị chặn trong phạm vi khối, build vẫn qua (file .jsx nên
    // không có TypeScript soát) nhưng production chết ngay ở lần render đầu với
    // "ReferenceError: thietBiYeu is not defined" — cả trang trắng, không riêng hiệu ứng 3D.
    // hardwareConcurrency có thể undefined ở vài trình duyệt; `|| 0` để không ra NaN.
    const thietBiYeu = (window.navigator.hardwareConcurrency || 0) <= 4;

    let boDung;
    try {
      boDung = new THREE.WebGLRenderer({
        alpha: true,
        antialias: !thietBiYeu,
        powerPreference: "high-performance",
      });
    } catch {
      return undefined;
    }

    boDung.setPixelRatio(Math.min(window.devicePixelRatio || 1, thietBiYeu ? 1 : 1.5));
    boDung.outputColorSpace = THREE.SRGBColorSpace;
    boDung.domElement.setAttribute("aria-hidden", "true");
    boDung.domElement.style.display = "block";
    boDung.domElement.style.width = "100%";
    boDung.domElement.style.height = "100%";
    khung.appendChild(boDung.domElement);

    const canh = new THREE.Scene();
    const mayAnh = new THREE.PerspectiveCamera(34, 1, 0.1, 40);
    mayAnh.position.set(0, 0.1, cheDo === "xu-ly" ? 6.2 : 7.2);

    canh.add(new THREE.HemisphereLight(0xffffff, 0x312e81, 2.2));
    const denChinh = new THREE.DirectionalLight(0xffffff, 3.6);
    denChinh.position.set(3, 4, 5);
    canh.add(denChinh);
    const denPhu = new THREE.PointLight(0x818cf8, 9, 8);
    denPhu.position.set(-3, -1, 3);
    canh.add(denPhu);

    const nhomChinh = new THREE.Group();
    canh.add(nhomChinh);
    const hatSang = taoHatSang(thietBiYeu ? 30 : 58, 3.2);
    canh.add(hatSang);

    const taiLieu = [];
    let vachQuet = null;
    let vongQuet = null;

    if (cheDo === "xu-ly") {
      const banQuet = new THREE.Mesh(
        new THREE.BoxGeometry(3.5, 2.7, 0.18),
        new THREE.MeshStandardMaterial({ color: 0x312e81, roughness: 0.32, metalness: 0.42 }),
      );
      banQuet.position.z = -0.28;
      nhomChinh.add(banQuet);

      const trang = taoTaiLieu(0x6366f1, 0.94);
      trang.rotation.x = -0.08;
      trang.position.z = 0.06;
      nhomChinh.add(trang);
      taiLieu.push(trang);

      vachQuet = new THREE.Mesh(
        new THREE.BoxGeometry(2.05, 0.055, 0.075),
        new THREE.MeshBasicMaterial({ color: 0x22d3ee, transparent: true, opacity: 0.95 }),
      );
      vachQuet.position.z = 0.22;
      nhomChinh.add(vachQuet);

      vongQuet = new THREE.Mesh(
        new THREE.TorusGeometry(1.95, 0.035, 8, 80),
        new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.5 }),
      );
      vongQuet.rotation.x = Math.PI / 2;
      nhomChinh.add(vongQuet);
      nhomChinh.rotation.x = -0.32;
    } else {
      const loi = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.62, 1),
        new THREE.MeshStandardMaterial({
          color: 0x4f46e5,
          emissive: 0x312e81,
          emissiveIntensity: 0.48,
          roughness: 0.28,
          metalness: 0.32,
        }),
      );
      loi.name = "loi";
      nhomChinh.add(loi);

      const vong = new THREE.Mesh(
        new THREE.TorusGeometry(1.12, 0.025, 8, 72),
        new THREE.MeshBasicMaterial({ color: 0xa5b4fc, transparent: true, opacity: 0.72 }),
      );
      vong.rotation.x = 1.08;
      nhomChinh.add(vong);

      const boTri = [
        [-2.15, 0.72, -0.25, -0.18],
        [2.1, 0.62, -0.15, 0.2],
        [-1.25, -1.45, 0.2, 0.12],
        [1.3, -1.38, 0.1, -0.14],
      ];
      for (const [x, y, z, xoay] of boTri) {
        const trang = taoTaiLieu(x < 0 ? 0x6366f1 : 0x22c55e, 0.63);
        trang.position.set(x, y, z);
        trang.rotation.set(-0.16, xoay, xoay);
        trang.userData.viTriY = y;
        nhomChinh.add(trang);
        taiLieu.push(trang);
      }
    }

    const mucTieuXoay = { x: 0, y: 0 };
    const giamChuyenDong = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let dangTrongKhung = true;
    let khungHinh = 0;
    const dongHo = new THREE.Clock();

    function doiKichThuoc() {
      const rong = Math.max(1, khung.clientWidth);
      const cao = Math.max(1, khung.clientHeight);
      mayAnh.aspect = rong / cao;
      mayAnh.updateProjectionMatrix();
      boDung.setSize(rong, cao, false);
      boDung.render(canh, mayAnh);
    }

    function capNhatTienDo(giaTri) {
      if (vachQuet) vachQuet.position.y = -0.88 + (giaTri / 100) * 1.76;
      if (vongQuet) vongQuet.material.opacity = 0.28 + (giaTri / 100) * 0.5;
      boDung.render(canh, mayAnh);
    }
    capNhatTinhRef.current = capNhatTienDo;

    function ve() {
      khungHinh = 0;
      if (!dangTrongKhung || document.hidden || giamChuyenDong) return;
      const thoiGian = dongHo.getElapsedTime();

      nhomChinh.rotation.y += (mucTieuXoay.y - nhomChinh.rotation.y) * 0.035;
      if (cheDo === "tong-quan") {
        nhomChinh.rotation.y += 0.0025;
        nhomChinh.rotation.x += (mucTieuXoay.x - nhomChinh.rotation.x) * 0.035;
        taiLieu.forEach((trang, chiSo) => {
          trang.position.y = trang.userData.viTriY + Math.sin(thoiGian * 0.85 + chiSo) * 0.09;
        });
        const loi = nhomChinh.getObjectByName("loi");
        if (loi) loi.rotation.y = thoiGian * 0.42;
      } else {
        nhomChinh.rotation.y = Math.sin(thoiGian * 0.38) * 0.12;
        taiLieu[0].position.z = 0.06 + Math.sin(thoiGian * 1.4) * 0.025;
        if (vachQuet) vachQuet.material.opacity = 0.68 + Math.sin(thoiGian * 4) * 0.25;
      }
      hatSang.rotation.y = thoiGian * 0.045;
      hatSang.rotation.z = thoiGian * 0.018;
      boDung.render(canh, mayAnh);
      khungHinh = window.requestAnimationFrame(ve);
    }

    function batDauVe() {
      if (!khungHinh && dangTrongKhung && !document.hidden && !giamChuyenDong) {
        dongHo.start();
        khungHinh = window.requestAnimationFrame(ve);
      }
    }

    function theoConTro(event) {
      const hop = khung.getBoundingClientRect();
      mucTieuXoay.y = ((event.clientX - hop.left) / Math.max(1, hop.width) - 0.5) * 0.34;
      mucTieuXoay.x = ((event.clientY - hop.top) / Math.max(1, hop.height) - 0.5) * 0.18;
    }

    const theoDoiKichThuoc = new ResizeObserver(doiKichThuoc);
    const theoDoiHienThi = new IntersectionObserver(([muc]) => {
      dangTrongKhung = muc.isIntersecting;
      if (dangTrongKhung) batDauVe();
      else if (khungHinh) {
        window.cancelAnimationFrame(khungHinh);
        khungHinh = 0;
      }
    });
    const khiDoiTrangThaiTab = () => {
      if (document.hidden && khungHinh) {
        window.cancelAnimationFrame(khungHinh);
        khungHinh = 0;
      } else {
        batDauVe();
      }
    };

    theoDoiKichThuoc.observe(khung);
    theoDoiHienThi.observe(khung);
    document.addEventListener("visibilitychange", khiDoiTrangThaiTab);
    if (!giamChuyenDong) khung.addEventListener("pointermove", theoConTro, { passive: true });
    doiKichThuoc();
    capNhatTienDo(tienDoRef.current);
    batDauVe();

    return () => {
      capNhatTinhRef.current = null;
      theoDoiKichThuoc.disconnect();
      theoDoiHienThi.disconnect();
      document.removeEventListener("visibilitychange", khiDoiTrangThaiTab);
      khung.removeEventListener("pointermove", theoConTro);
      if (khungHinh) window.cancelAnimationFrame(khungHinh);
      canh.traverse((vatThe) => {
        if (vatThe.geometry) vatThe.geometry.dispose();
        const vatLieu = vatThe.material;
        if (Array.isArray(vatLieu)) vatLieu.forEach((muc) => muc.dispose());
        else vatLieu?.dispose();
      });
      boDung.dispose();
      boDung.forceContextLoss();
      boDung.domElement.remove();
    };
  }, [cheDo]);

  return <div ref={khungRef} className="h-full w-full" aria-hidden="true" />;
}
