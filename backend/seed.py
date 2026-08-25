"""
Tạo bảng (nếu chưa có) + seed 29 mục checklist gốc (0. Checklist hồ sơ Canada.docx).
Chạy: ./.venv/bin/python seed.py
Idempotent — chạy lại nhiều lần không tạo trùng (dùng merge theo id).
"""
from dotenv import load_dotenv

load_dotenv(".env.local")
load_dotenv("../.env.local")
load_dotenv("../.env")

from sqlalchemy import select

from db import SessionLocal, engine
from models import Base, ChecklistItem

GROUP_A_PERSONAL = "Giấy tờ cá nhân"
GROUP_A_DEGREE = "Giấy tờ chứng minh bằng cấp"
GROUP_A_WORK = "Giấy tờ chứng minh kinh nghiệm làm việc"
GROUP_A_FINANCE = "Giấy tờ chứng minh tài chính"
GROUP_B_PERSONAL = "Giấy tờ cá nhân (người phụ thuộc)"

CHECKLIST_ITEMS = [
    # --- Section A / Giấy tờ cá nhân ---
    dict(id="passport", order=1, section="A", group=GROUP_A_PERSONAL, nameVi="Passport",
         note="Cung cấp tất cả Passport từ trước đến nay",
         verificationNote="Xem lịch sử đi nước ngoài, nếu khách có đi bất hợp pháp thì yêu cầu "
                           "khách làm lại passport mới. Ngày hết hạn passport còn khoảng 1 năm "
                           "thì yêu cầu khách làm lại luôn."),
    dict(id="cccd", order=2, section="A", group=GROUP_A_PERSONAL, nameVi="Căn cước công dân"),
    dict(id="cmnd-cu", order=3, section="A", group=GROUP_A_PERSONAL,
         nameVi="Chứng minh nhân dân cũ (nếu có)",
         note="Cung cấp thêm giấy xác nhận đổi CMND (nếu có)", isOptional=True),
    dict(id="tam-tru-ct07", order=5, section="A", group=GROUP_A_PERSONAL,
         nameVi="Sổ tạm trú / giấy xác nhận tạm trú / CT07",
         verificationNote="Phải có đầy đủ thành viên trong gia đình (ba mẹ, anh chị em... con "
                           "cái). Phải còn thời hạn trong vòng 1 năm, phải đúng thông tin như "
                           "CCCD... Phải có dấu mộc đỏ của uỷ ban."),
    dict(id="giay-khai-sinh", order=6, section="A", group=GROUP_A_PERSONAL, nameVi="Giấy khai sinh",
         verificationNote="Thường kiểm tra ngày tháng năm sinh của cha mẹ có khớp không."),
    dict(id="dang-ky-ket-hon", order=7, section="A", group=GROUP_A_PERSONAL,
         nameVi="Giấy đăng ký kết hôn (nếu có)", isOptional=True),
    dict(id="quyet-dinh-ly-hon", order=8, section="A", group=GROUP_A_PERSONAL,
         nameVi="Giấy quyết định ly hôn (nếu có)", isOptional=True),
    dict(id="hinh-the-trang", order=9, section="A", group=GROUP_A_PERSONAL, nameVi="Hình thẻ trắng",
         note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh."),
    dict(id="ly-lich-tu-phap-so-2", order=10, section="A", group=GROUP_A_PERSONAL,
         nameVi="Lý lịch tư pháp số 2",
         verificationNote="Hạn trong vòng 1 năm, phải có chữ ký điện tử và tên của cán bộ làm "
                           "giấy, phải khớp thông tin như CCCD, ngày cấp..."),
    dict(id="ly-lich-tu-phap-nuoc-ngoai", order=11, section="A", group=GROUP_A_PERSONAL,
         nameVi="Lý lịch tư pháp tại nước ngoài (nếu có)", isOptional=True),
    dict(id="giay-kham-suc-khoe", order=12, section="A", group=GROUP_A_PERSONAL,
         nameVi="Giấy khám sức khoẻ tại nơi chỉ định", note="Tổ chức di cư quốc tế IOM"),

    # --- Section A / Giấy tờ chứng minh bằng cấp ---
    dict(id="bang-tot-nghiep-c2-c3", order=13, section="A", group=GROUP_A_DEGREE,
         nameVi="Bằng tốt nghiệp Cấp 2 hoặc Cấp 3", note="Bằng cấp nào cao nhất thì lấy bằng đó",
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="hoc-ba-c2-c3", order=14, section="A", group=GROUP_A_DEGREE,
         nameVi="Học bạ Cấp 2 hoặc Học bạ Cấp 3", note="Nếu mất học bạ thì cung cấp bảng điểm học tập"),
    dict(id="bang-trung-cap-cd-dh", order=15, section="A", group=GROUP_A_DEGREE,
         nameVi="Bằng Trung cấp / Cao đẳng / Đại học",
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="bang-diem-trung-cap-cd-dh", order=16, section="A", group=GROUP_A_DEGREE,
         nameVi="Bảng điểm Trung cấp / Cao đẳng / Đại học"),
    dict(id="chung-chi-nghe-khac", order=17, section="A", group=GROUP_A_DEGREE,
         nameVi="Các bằng cấp / chứng chỉ nghề khác", note="Ví dụ: chứng chỉ nghề nail", isOptional=True),
    dict(id="chung-chi-tieng-anh", order=18, section="A", group=GROUP_A_DEGREE,
         nameVi="Chứng chỉ thi tiếng Anh",
         verificationNote="Nếu thi online: ngày thi phải sau ngày cấp giấy xác nhận học tiếng "
                           "Anh tại trung tâm. Phải đúng với năng lực của khách — vd khách chỉ "
                           "học hết C2 thì không thể thi C1-C2; khách lớn tuổi khoảng B2; khách "
                           "có bằng ĐH thì C1 vẫn ổn. Giấy xác nhận học tại trung tâm: thời gian "
                           "học và trình độ phải hợp lý, phải có dấu xác nhận, song ngữ hoặc "
                           "tiếng Anh — không dùng giấy xác nhận chỉ bằng tiếng Việt."),

    # --- Section A / Giấy tờ chứng minh kinh nghiệm làm việc ---
    dict(id="thu-xac-nhan-kinh-nghiem", order=19, section="A", group=GROUP_A_WORK,
         nameVi="Thư xác nhận kinh nghiệm làm việc"),
    dict(id="thu-tai-tuyen-dung", order=20, section="A", group=GROUP_A_WORK,
         nameVi="Thư tái tuyển dụng"),
    dict(id="thu-xac-nhan-ubnd", order=21, section="A", group=GROUP_A_WORK,
         nameVi="Thư xác nhận từ cơ quan nhà nước (UBND)"),
    dict(id="hop-dong-lao-dong", order=22, section="A", group=GROUP_A_WORK, nameVi="Hợp đồng lao động"),
    dict(id="sao-ke-ngan-hang-phieu-luong", order=23, section="A", group=GROUP_A_WORK,
         nameVi="Sao kê ngân hàng / Phiếu lương"),

    # --- Section A / Giấy tờ chứng minh tài chính ---
    # Tách "Sổ tiết kiệm và xác nhận số dư sổ tiết kiệm" (1 mục) thành 2 mục riêng — 2 loại
    # giấy tờ khác nhau (sổ vật lý vs giấy xác nhận của ngân hàng), nhân viên cần theo dõi
    # đủ/thiếu riêng từng loại thay vì gộp chung 1 mục.
    dict(id="so-tiet-kiem", order=24, section="A", group=GROUP_A_FINANCE,
         nameVi="Sổ tiết kiệm", note="Yêu cầu làm bản song ngữ Anh - Việt."),
    dict(id="xac-nhan-so-du-tiet-kiem", order=25, section="A", group=GROUP_A_FINANCE,
         nameVi="Giấy xác nhận số dư sổ tiết kiệm",
         note="Yêu cầu làm bản song ngữ Anh - Việt. Độc thân: tối thiểu 100-150 triệu. "
              "Đã kết hôn: tối thiểu 200-300 triệu. Kết hôn có 1 con: 350 triệu. "
              "Kết hôn 2 con: 400 triệu. Thêm 1 người thì tăng thêm 50 triệu.",
         verificationNote="Tuỳ theo khách mà bỏ số dư cho hợp lý."),
    dict(id="giay-to-nha-dat", order=26, section="A", group=GROUP_A_FINANCE,
         nameVi="Giấy tờ nhà đất / quyền sử dụng đất",
         note="Sao y công chứng tại văn phòng công chứng hoặc cơ quan nhà nước, không quá 1 tháng. "
              "Nếu không đứng tên trên sổ hồng/sổ đỏ thì lấy giấy tờ đất của bố mẹ ruột. "
              "Nếu đang thế chấp ngân hàng thì nhờ ngân hàng photo công chứng 1 bản."),

    # --- Section B / Giấy tờ cá nhân (vợ/chồng, con) ---
    dict(id="passport-vo-chong", order=27, section="B", group=GROUP_B_PERSONAL,
         nameVi="Passport vợ/chồng", appliesTo="SPOUSE"),
    dict(id="cmnd-vo-chong", order=29, section="B", group=GROUP_B_PERSONAL,
         nameVi="Chứng minh nhân dân vợ/chồng (nếu có)", isOptional=True, appliesTo="SPOUSE"),
    dict(id="hinh-the-trang-phu-thuoc", order=31, section="B", group=GROUP_B_PERSONAL,
         nameVi="Hình thẻ trắng (vợ/chồng và từng con)",
         note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh.",
         appliesTo="DEPENDENTS", quantityRule="PER_DEPENDENT"),
    dict(id="quyet-dinh-ly-hon-vo-chong", order=32, section="B", group=GROUP_B_PERSONAL,
         nameVi="Giấy quyết định ly hôn (nếu có)", note="Trường hợp vợ/chồng đã từng ly hôn thì bổ sung",
         isOptional=True, appliesTo="SPOUSE"),
    dict(id="cccd-me-vo-chong", order=33, section="B", group=GROUP_B_PERSONAL,
         nameVi="Căn cước công dân mẹ", appliesTo="ALWAYS"),
    dict(id="cccd-cha-vo-chong", order=34, section="B", group=GROUP_B_PERSONAL,
         nameVi="Căn cước công dân cha", appliesTo="ALWAYS"),
    # Chỉ cần CCCD của 1 người (vợ HOẶC chồng, tuỳ giới tính vợ/chồng của đương đơn) — dùng
    # eitherWithId để hễ 1 trong 2 mục đủ thì coi cả 2 đủ, tránh checklist bị kẹt vĩnh viễn ở
    # mục không thể nộp được (vd đương đơn là nữ thì không thể nào có "CCCD vợ").
    dict(id="cccd-vo", order=37, section="B", group=GROUP_B_PERSONAL,
         nameVi="Căn cước công dân vợ", appliesTo="SPOUSE", eitherWithId="cccd-chong",
         note="Xác định qua trường Giới tính trên CCCD: Nữ → mục này (vợ)."),
    dict(id="cccd-chong", order=38, section="B", group=GROUP_B_PERSONAL,
         nameVi="Căn cước công dân chồng", appliesTo="SPOUSE", eitherWithId="cccd-vo",
         note="Xác định qua trường Giới tính trên CCCD: Nam → mục này (chồng)."),
    dict(id="giay-khai-sinh-con-cai", order=39, section="B", group=GROUP_B_PERSONAL,
         nameVi="Giấy khai sinh con cái",
         note="Thu đầy đủ khai sinh của tất cả các con. Bản chính: chỉ cần scan gửi. "
              "Bản sao hoặc bản trích lục: thu bản gốc.",
         appliesTo="CHILDREN", quantityRule="PER_CHILD"),
]


def main():
    Base.metadata.create_all(engine)

    db = SessionLocal()
    try:
        for data in CHECKLIST_ITEMS:
            data.setdefault("note", None)
            data.setdefault("verificationNote", None)
            data.setdefault("isOptional", False)
            data.setdefault("appliesTo", "ALWAYS")
            data.setdefault("quantityRule", "FIXED_1")
            data.setdefault("eitherWithId", None)

            existing = db.get(ChecklistItem, data["id"])
            if existing:
                for k, v in data.items():
                    setattr(existing, k, v)
            else:
                db.add(ChecklistItem(**data))

        # Dọn các mục cũ đã bị bỏ khỏi CHECKLIST_ITEMS (vd "Sổ Hộ Khẩu" — không dùng nữa) —
        # để seed.py thực sự idempotent theo đúng nghĩa (state khớp với danh sách hiện tại,
        # không chỉ cộng dồn/cập nhật), tránh phải nhớ chạy thêm lệnh DELETE tay mỗi lần bỏ
        # 1 mục. Document.matchedChecklistItemId có ondelete="SET NULL" nên an toàn khi xoá.
        current_ids = {data["id"] for data in CHECKLIST_ITEMS}
        stale = db.scalars(select(ChecklistItem).where(ChecklistItem.id.notin_(current_ids))).all()
        for item in stale:
            db.delete(item)
        if stale:
            print(f"Removed {len(stale)} stale checklist item(s): {[i.id for i in stale]}")

        db.commit()
        print(f"Seeded {len(CHECKLIST_ITEMS)} checklist items.")
    finally:
        db.close()


if __name__ == "__main__":
    main()
