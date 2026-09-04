"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { createTimeline, stagger, utils } from "animejs";
// Import CÓ TÁC DỤNG PHỤ, không phải import thừa: nạp module này thì anime.js mới tự đăng ký
// adapter Three.js. Thiếu nó, animate() coi mỗi instance là object JavaScript thường và ghi
// thẳng vào thuộc tính .x/.y/.z — ma trận instance không bao giờ được ghi lại nên lưới đứng im
// hoàn toàn mà KHÔNG báo lỗi gì. Đã mất thời gian vì chuyện này, đừng gộp/bỏ dòng import.
import { getInstances } from "animejs/adapters/three";

const COT = 26; // số ô theo chiều ngang
const HANG = 26; // số ô theo chiều dọc — đủ cao để lưới vẫn tràn mép trên màn hình dọc
const BUOC = 0.56; // khoảng cách tâm hai ô liền kề
const CANH_O = 0.4; // cạnh mỗi khối lập phương

const MAU_DAU = new THREE.Color(0x4f46e5); // chàm — màu chủ đạo của giao diện
const MAU_CUOI = new THREE.Color(0x22d3ee); // lơ — màu nhấn
const MAU_TICK = new THREE.Color(0x34d399); // lục — ô thuộc dấu tick
const MAU_LUU_Y = new THREE.Color(0xfbbf24); // hổ phách — vài ô rải rác, nhắc trạng thái "cần xem lại"

// Dấu tick vẽ bằng hai đoạn thẳng. Ô nào nằm sát hai đoạn này thì đổi màu, nên khi lưới ráp
// xong người xem thấy hiện ra dấu ✓ — nói đúng việc sản phẩm làm (soát hồ sơ đủ hay thiếu)
// thay vì chỉ là hiệu ứng trang trí chung chung.
//
// Toạ độ ghi bằng ĐƠN VỊ THẾ GIỚI của three.js, KHÔNG phải toạ độ lưới chuẩn hoá về [-0.5, 0.5]:
// lưới rộng gấp khoảng 1,8 lần chiều cao nên cùng một con số ở trục x dài hơn hẳn ở trục y,
// dấu tick vẽ theo toạ độ chuẩn hoá bị kéo bè sang ngang và không còn ra hình ✓.
//
// Đặt cao hơn tâm vì khối chữ nằm ở phần dưới màn hình; để tick đúng giữa thì chữ cắt ngang
// ngay giữa dấu ✓, không đọc được cả hình lẫn chữ.
const DOAN_TICK = [
  [-1.75, 0.35, -0.15, -1.05],
  [-0.15, -1.05, 2.15, 2.35],
];
const DAY_TICK = 0.48; // nửa bề dày nét, tính theo khoảng cách tâm ô (BUOC) nên ra nét dày ~2 ô
// Bán kính vùng phải luôn nằm trong khung hình. Điểm xa tâm nhất của hai đoạn trên là 2.35,
// nhưng một ô được tô màu khi TÂM nó cách nét không quá DAY_TICK, và bản thân ô còn rộng
// CANH_O/2 nữa — lấy đúng 2.35 thì trên màn hình dọc đầu nhánh dài bị cắt mất. Cộng đủ cả hai.
const BAN_KINH_TICK = 2.35 + 0.48 + 0.2;

function khoangCachToiDoan(x, y, doan) {
  const [x1, y1, x2, y2] = doan;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const doDaiBinhPhuong = dx * dx + dy * dy;
  // Chiếu điểm xuống đoạn rồi kẹp về [0,1] để không tính nhầm sang phần kéo dài của đường thẳng.
  const t = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / doDaiBinhPhuong));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

function laOTick(x, y) {
  return DOAN_TICK.some((doan) => khoangCachToiDoan(x, y, doan) < DAY_TICK);
}

// Rải ô màu hổ phách bằng hàm băm chứ không phải phép chia lấy dư trên chỉ số ô: `chiSo % n`
// là quan hệ tuyến tính nên trên lưới hàng-trước-cột-sau nó xếp thành ĐƯỜNG CHÉO ĐỀU TĂM TẮP,
// nhìn ra ngay là một vệt lỗi chứ không phải điểm nhấn rải rác. Băm rồi lấy phần thập phân thì
// vẫn tất định (mọi máy ra cùng một hình) mà mắt không bắt được quy luật.
function laOLuuY(chiSo) {
  const bam = Math.sin(chiSo * 127.1 + 311.7) * 43758.5453;
  return bam - Math.floor(bam) < 0.022;
}

/**
 * Lưới khối 3D cho màn intro: các ô bay từ xa về ráp thành mặt phẳng theo kiểu lan từ tâm,
 * gợn một đợt sóng, rồi lao qua máy quay để nhường chỗ cho ứng dụng.
 *
 * Toàn bộ chuyển động do anime.js điều khiển qua adapter Three.js, KHÔNG tự nội suy trong
 * vòng lặp vẽ: hai bên cùng ghi vào một thuộc tính sẽ giành nhau và giật hình.
 * Vòng lặp vẽ chỉ lo hai việc riêng của nó là xoay nhẹ cả nhóm và bám con trỏ.
 */
export default function IntroCanvas({ khiXong }) {
  const khungRef = useRef(null);
  const khiXongRef = useRef(khiXong);

  useEffect(() => {
    khiXongRef.current = khiXong;
  }, [khiXong]);

  useEffect(() => {
    const khung = khungRef.current;
    if (!khung) return undefined;

    const thietBiYeu = (window.navigator.hardwareConcurrency || 0) <= 4;

    let boDung;
    try {
      boDung = new THREE.WebGLRenderer({ alpha: true, antialias: !thietBiYeu });
    } catch {
      // Máy không dựng được WebGL thì bỏ qua phần 3D nhưng vẫn phải báo xong, nếu không lớp
      // phủ intro sẽ nằm lại che kín ứng dụng vĩnh viễn.
      khiXongRef.current?.();
      return undefined;
    }

    boDung.setPixelRatio(Math.min(window.devicePixelRatio || 1, thietBiYeu ? 1 : 1.5));
    boDung.outputColorSpace = THREE.SRGBColorSpace;
    boDung.domElement.style.display = "block";
    boDung.domElement.style.width = "100%";
    boDung.domElement.style.height = "100%";
    khung.appendChild(boDung.domElement);

    const canh = new THREE.Scene();
    const mayAnh = new THREE.PerspectiveCamera(38, 1, 0.1, 60);
    mayAnh.position.z = 12;

    canh.add(new THREE.HemisphereLight(0xc7d2fe, 0x0b1020, 2.4));
    const denChinh = new THREE.DirectionalLight(0xffffff, 2.6);
    denChinh.position.set(4, 6, 8);
    canh.add(denChinh);
    const denVien = new THREE.PointLight(0x22d3ee, 14, 22);
    denVien.position.set(-6, -3, 6);
    canh.add(denVien);

    const nhom = new THREE.Group();
    canh.add(nhom);

    const soO = COT * HANG;
    const hinhO = new RoundedBoxGeometry(CANH_O, CANH_O, CANH_O, 2, 0.09);
    const vatLieu = new THREE.MeshStandardMaterial({ roughness: 0.34, metalness: 0.22 });
    const luoi = new THREE.InstancedMesh(hinhO, vatLieu, soO);
    // Ma trận thay đổi mỗi khung hình nên phải báo động, mặc định three.js coi là tĩnh.
    luoi.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    nhom.add(luoi);

    // Dựng sẵn dữ liệu từng ô: vị trí đích, vị trí xuất phát ở xa, màu.
    const oNha = new Array(soO);
    const oDau = new Array(soO);
    const chiSoTick = [];
    const mau = new THREE.Color();
    for (let hang = 0; hang < HANG; hang += 1) {
      for (let cot = 0; cot < COT; cot += 1) {
        // Thứ tự hàng-trước-cột-sau phải khớp với grid [COT, HANG] của stagger bên dưới,
        // nếu đảo thì hiệu ứng lan từ tâm sẽ ra sai hướng.
        const chiSo = hang * COT + cot;
        const x = (cot - (COT - 1) / 2) * BUOC;
        const y = ((HANG - 1) / 2 - hang) * BUOC;
        const khoangTam = Math.hypot(x, y);

        // Mặt lưới hơi gợn thay vì phẳng lì, để lúc đứng yên vẫn thấy chiều sâu.
        oNha[chiSo] = { x, y, z: Math.sin(khoangTam * 0.62) * 0.22 };
        oDau[chiSo] = {
          z: -9 - Math.random() * 7,
          rotateX: (Math.random() - 0.5) * 3.4,
          rotateY: (Math.random() - 0.5) * 3.4,
        };

        const trongTick = laOTick(x, y);
        if (trongTick) {
          chiSoTick.push(chiSo);
          mau.copy(MAU_TICK);
        } else if (laOLuuY(chiSo)) {
          mau.copy(MAU_LUU_Y);
        } else {
          mau.copy(MAU_DAU).lerp(MAU_CUOI, cot / (COT - 1));
        }
        luoi.setColorAt(chiSo, mau);
      }
    }
    luoi.instanceColor.needsUpdate = true;

    const o = getInstances(luoi);
    const oTick = chiSoTick.map((chiSo) => o[chiSo]);

    utils.set(o, {
      x: (muc, i) => oNha[i].x,
      y: (muc, i) => oNha[i].y,
      z: (muc, i) => oDau[i].z,
      rotateX: (muc, i) => oDau[i].rotateX,
      rotateY: (muc, i) => oDau[i].rotateY,
      scale: 0,
    });

    const lanTuTam = (buoc) => stagger(buoc, { grid: [COT, HANG], from: "center" });

    const kichBan = createTimeline({
      defaults: { ease: "outExpo" },
      onComplete: () => khiXongRef.current?.(),
    })
      // 1. Ráp lưới: các ô lan từ tâm ra ngoài — chính là kiểu stagger theo lưới của anime.js.
      .add(
        o,
        {
          z: (muc, i) => oNha[i].z,
          rotateX: 0,
          rotateY: 0,
          scale: 1,
          duration: 1000,
          delay: lanTuTam(11),
        },
        0,
      )
      // 2. Dấu tick nảy lên trước một nhịp để mắt bắt được hình.
      .add(
        oTick,
        { scale: [{ to: 1.5, duration: 260 }, { to: 1.12, duration: 340 }], delay: stagger(9) },
        900,
      )
      // 3. Một đợt sóng chạy qua mặt lưới, cũng lan từ tâm.
      .add(
        o,
        {
          z: [
            { to: (muc, i) => oNha[i].z + 0.85, duration: 300, ease: "outSine" },
            { to: (muc, i) => oNha[i].z, duration: 430, ease: "inOutSine" },
          ],
          delay: lanTuTam(6),
        },
        1250,
      )
      // 4. Lao qua máy quay rồi tắt, trả màn hình lại cho ứng dụng.
      .add(
        o,
        { z: 11.4, scale: 0, duration: 620, ease: "inQuad", delay: lanTuTam(5) },
        2150,
      );

    const mucTieuXoay = { x: 0, y: 0 };
    const dongHo = new THREE.Clock();

    function doiKichThuoc() {
      const rong = Math.max(1, khung.clientWidth);
      const cao = Math.max(1, khung.clientHeight);
      mayAnh.aspect = rong / cao;
      // Lùi máy quay đủ xa để lưới luôn tràn khỏi mép màn hình ở mọi tỷ lệ; thấy được viền
      // lưới thì hiệu ứng lộ ngay là một tấm phẳng nhỏ, mất cảm giác không gian.
      const nuaGoc = Math.tan((mayAnh.fov * Math.PI) / 360);
      const canTheoCao = (HANG * BUOC) / 2 / nuaGoc;
      const canTheoRong = (COT * BUOC) / 2 / (nuaGoc * mayAnh.aspect);
      // Trên màn hình hẹp (điện thoại dựng đứng), khoảng cách "vừa đủ tràn mép" lại cắt mất
      // một phần dấu tick. Lùi thêm khi cần: thà thấy rìa lưới còn hơn thấy nửa dấu ✓.
      const vuaTick = BAN_KINH_TICK / (nuaGoc * Math.min(mayAnh.aspect, 1));
      mayAnh.position.z = Math.max(Math.min(canTheoCao, canTheoRong) * 0.82, vuaTick);
      mayAnh.updateProjectionMatrix();
      boDung.setSize(rong, cao, false);
    }

    function ve() {
      const thoiGian = dongHo.getElapsedTime();
      // Vòng lặp vẽ chỉ chạm vào cả NHÓM, không chạm vào từng ô: mọi thuộc tính của ô đang do
      // anime.js giữ, ghi đè ở đây sẽ giật hình.
      nhom.rotation.y += (mucTieuXoay.y - nhom.rotation.y) * 0.045;
      nhom.rotation.x += (mucTieuXoay.x - nhom.rotation.x) * 0.045;
      nhom.rotation.z = Math.sin(thoiGian * 0.25) * 0.02;
      boDung.render(canh, mayAnh);
    }

    function theoConTro(sukien) {
      mucTieuXoay.y = (sukien.clientX / Math.max(1, window.innerWidth) - 0.5) * 0.5;
      mucTieuXoay.x = (sukien.clientY / Math.max(1, window.innerHeight) - 0.5) * 0.26;
    }

    const theoDoiKichThuoc = new ResizeObserver(doiKichThuoc);
    theoDoiKichThuoc.observe(khung);
    window.addEventListener("pointermove", theoConTro, { passive: true });
    doiKichThuoc();
    boDung.setAnimationLoop(ve);

    return () => {
      theoDoiKichThuoc.disconnect();
      window.removeEventListener("pointermove", theoConTro);
      boDung.setAnimationLoop(null);
      kichBan.revert();
      hinhO.dispose();
      vatLieu.dispose();
      luoi.dispose();
      boDung.dispose();
      boDung.forceContextLoss();
      boDung.domElement.remove();
    };
  }, []);

  return <div ref={khungRef} className="h-full w-full" aria-hidden="true" />;
}
