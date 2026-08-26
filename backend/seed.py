"""
Tạo bảng (nếu chưa có) + seed toàn bộ checklist. Có 2 bộ checklist HOÀN TOÀN riêng theo
Case.skillLevel ("LOW_SKILL" / "HIGH_SKILL") — mỗi bộ tự xử lý SINGLE vs MARRIED (và số con)
bằng field `appliesTo` (xem is_item_applicable ở completeness.py), giống hệt cách app đã làm
từ trước — chỉ khác là giờ có 2 bộ độc lập thay vì 1 bộ chung cho mọi hồ sơ.

Nguồn: 4 file checklist khách hàng gửi (CHECKLIST – LOW/HIGH SKILLED – SINGLE/MARRIED),
giữ đúng thứ tự mục + tên mục như bản gốc trong từng trường hợp.

Chạy: ./.venv/bin/python seed.py
Idempotent — chạy lại nhiều lần không tạo trùng (dùng merge theo id), tự xoá mục cũ không
còn trong danh sách bên dưới (xem main()).
"""
from dotenv import load_dotenv

load_dotenv(".env.local")
load_dotenv("../.env.local")
load_dotenv("../.env")

from sqlalchemy import select

from db import SessionLocal, engine
from models import Base, ChecklistItem

SECTION_APPLICANT = "Hồ sơ đương đơn"
SECTION_DEPENDENTS = "Hồ sơ người phụ thuộc"
SECTION_SPOUSE = "Hồ sơ người phụ thuộc (Vợ/chồng)"

GROUP_PERSONAL = "Giấy tờ cá nhân"
GROUP_DEGREE = "Giấy tờ chứng minh bằng cấp"
GROUP_WORK = "Giấy tờ chứng minh kinh nghiệm làm việc"
GROUP_FINANCE = "Giấy tờ chứng minh tài chính"
GROUP_WORK_FINANCE = "Giấy tờ chứng minh kinh nghiệm làm việc & tài chính"
GROUP_OTHER = "Giấy tờ khác"
GROUP_DEPENDENT_PERSONAL = "Giấy tờ cá nhân (người phụ thuộc)"


# ============================================================================
# BỘ 1 — LOW_SKILL (checklist "LOW SKILLED – SINGLE" / "LOW SKILLED – MARRIED")
# ============================================================================
LOW_SKILL_ITEMS = [
    # --- I. Giấy tờ cá nhân ---
    dict(id="passport", order=1, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Passport",
         note="Cung cấp tất cả Passport từ trước đến nay",
         verificationNote="Xem lịch sử đi nước ngoài, nếu khách có đi bất hợp pháp thì yêu cầu "
                           "khách làm lại passport mới. Ngày hết hạn passport còn khoảng 1 năm "
                           "thì yêu cầu khách làm lại luôn."),
    dict(id="cccd", order=2, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Căn cước công dân"),
    dict(id="cmnd-cu", order=3, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Chứng minh nhân dân cũ (nếu có)",
         note="Cung cấp thêm giấy xác nhận đổi CMND (nếu có)", isOptional=True),
    dict(id="tam-tru-ct07", order=4, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy xác nhận cư trú, mẫu CT07/CT08",
         verificationNote="Phải có đầy đủ thành viên trong gia đình (ba mẹ, anh chị em... con "
                           "cái). Phải còn thời hạn trong vòng 1 năm, phải đúng thông tin như "
                           "CCCD... Phải có dấu mộc đỏ của uỷ ban."),
    dict(id="giay-khai-sinh", order=5, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy khai sinh",
         verificationNote="Thường kiểm tra ngày tháng năm sinh của cha mẹ có khớp không."),
    dict(id="dang-ky-ket-hon", order=6, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy đăng ký kết hôn (Nếu có)", isOptional=True, appliesTo="SPOUSE"),
    dict(id="quyet-dinh-ly-hon", order=7, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy quyết định ly hôn (Nếu có)", isOptional=True),
    dict(id="hinh-the-trang", order=8, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Ảnh thẻ phông trắng",
         note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh."),
    dict(id="ly-lich-tu-phap-so-2", order=9, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp số 2",
         verificationNote="Hạn trong vòng 1 năm, phải có chữ ký điện tử và tên của cán bộ làm "
                           "giấy, phải khớp thông tin như CCCD, ngày cấp..."),
    dict(id="ly-lich-tu-phap-nuoc-ngoai", order=10, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp tại nước ngoài (nếu có)", isOptional=True),
    dict(id="giay-kham-suc-khoe", order=11, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy khám sức khoẻ tại nơi chỉ định (nếu có)", isOptional=True,
         note="Tổ chức di cư quốc tế IOM"),

    # --- II. Giấy tờ chứng minh bằng cấp ---
    dict(id="giay-xac-nhan-qua-trinh-hoc-tap", order=12, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Giấy xác nhận quá trình học tập"),
    dict(id="bang-tot-nghiep-c2-c3", order=13, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bằng tốt nghiệp THCS / THPT",
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="hoc-ba-c2-c3", order=14, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Học bạ THCS/ THPT", note="Nếu mất học bạ thì cung cấp bảng điểm học tập"),
    dict(id="bang-trung-cap-cd-dh", order=15, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bằng Trung Cấp / Cao Đẳng/ Đại học (Nếu có)", isOptional=True,
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="bang-diem-trung-cap-cd-dh", order=16, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bảng điểm Trung Cấp / Cao Đẳng/ Đại học (Nếu có)", isOptional=True),
    dict(id="chung-chi-nghe-khac", order=17, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Các bằng cấp/chứng chỉ nghề khác (Nếu có)", isOptional=True,
         note="Ví dụ: chứng chỉ nghề nail"),
    dict(id="chung-chi-tieng-anh", order=18, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Chứng chỉ thi tiếng Anh",
         verificationNote="Nếu thi online: ngày thi phải sau ngày cấp giấy xác nhận học tiếng "
                           "Anh tại trung tâm. Phải đúng với năng lực của khách — vd khách chỉ "
                           "học hết C2 thì không thể thi C1-C2; khách lớn tuổi khoảng B2; khách "
                           "có bằng ĐH thì C1 vẫn ổn. Giấy xác nhận học tại trung tâm: thời gian "
                           "học và trình độ phải hợp lý, phải có dấu xác nhận, song ngữ hoặc "
                           "tiếng Anh — không dùng giấy xác nhận chỉ bằng tiếng Việt."),

    # --- III. Giấy tờ chứng minh kinh nghiệm làm việc ---
    dict(id="thu-xac-nhan-kinh-nghiem", order=19, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận kinh nghiệm làm việc"),
    dict(id="thu-tai-tuyen-dung", order=20, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận tái tuyển dụng"),
    dict(id="thu-xac-nhan-ubnd", order=21, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận của UBND (nếu có)", isOptional=True),
    dict(id="hop-dong-lao-dong", order=22, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Hợp đồng lao động"),
    dict(id="sao-ke-ngan-hang-phieu-luong", order=23, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Phiếu lương / sao kê lương"),

    # --- IV. Giấy tờ chứng minh tài chính ---
    dict(id="so-tiet-kiem", order=24, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Sổ tiết kiệm", note="Yêu cầu làm bản song ngữ Anh - Việt."),
    dict(id="xac-nhan-so-du-tiet-kiem", order=25, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Giấy xác nhận số dư sổ tiết kiệm",
         note="Yêu cầu làm bản song ngữ Anh - Việt. Độc thân: tối thiểu 100-150 triệu. "
              "Đã kết hôn: tối thiểu 200-300 triệu. Kết hôn có 1 con: 350 triệu. "
              "Kết hôn 2 con: 400 triệu. Thêm 1 người thì tăng thêm 50 triệu.",
         verificationNote="Tuỳ theo khách mà bỏ số dư cho hợp lý."),
    dict(id="giay-to-nha-dat", order=26, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Quyền sử dụng đất",
         note="Sao y công chứng tại văn phòng công chứng hoặc cơ quan nhà nước, không quá 1 tháng. "
              "Nếu không đứng tên trên sổ hồng/sổ đỏ thì lấy giấy tờ đất của bố mẹ ruột. "
              "Nếu đang thế chấp ngân hàng thì nhờ ngân hàng photo công chứng 1 bản."),

    # --- V. Giấy tờ cá nhân (người phụ thuộc) — chỉ hiện khi đã kết hôn / có con ---
    dict(id="cccd-vo-chong", order=27, section=SECTION_DEPENDENTS, group=GROUP_DEPENDENT_PERSONAL,
         nameVi="Căn cước công dân vợ/chồng", appliesTo="SPOUSE"),
    dict(id="giay-khai-sinh-vo-chong", order=28, section=SECTION_DEPENDENTS, group=GROUP_DEPENDENT_PERSONAL,
         nameVi="Giấy khai sinh vợ/chồng", appliesTo="SPOUSE"),
    dict(id="giay-khai-sinh-con1", order=29, section=SECTION_DEPENDENTS, group=GROUP_DEPENDENT_PERSONAL,
         nameVi="Giấy khai sinh - con 1 (nếu có)", isOptional=True, appliesTo="CHILD_1"),
    dict(id="giay-khai-sinh-con2", order=30, section=SECTION_DEPENDENTS, group=GROUP_DEPENDENT_PERSONAL,
         nameVi="Giấy khai sinh - con 2 (nếu có)", isOptional=True, appliesTo="CHILD_2"),
    # Checklist LOW_SKILL-SINGLE gốc chỉ liệt kê tới con 2 (không có mục con 3), nhưng đây rõ
    # ràng là thiếu sót của bản gốc (không có lý do nghiệp vụ nào để hồ sơ độc thân có 3 con
    # lại không cần thu khai sinh con thứ 3) — dùng chung mục CHILD_3 này cho cả SINGLE lẫn
    # MARRIED thay vì chỉ giới hạn theo MARRIED như bản LOW_SKILL-MARRIED gốc.
    dict(id="giay-khai-sinh-con3", order=31, section=SECTION_DEPENDENTS, group=GROUP_DEPENDENT_PERSONAL,
         nameVi="Giấy khai sinh - con 3 (nếu có)", isOptional=True, appliesTo="CHILD_3"),

    # --- VI. Giấy tờ khác — bố mẹ ruột đương đơn, không phụ thuộc tình trạng hôn nhân ---
    dict(id="cccd-cha-vo-chong", order=32, section=SECTION_DEPENDENTS, group=GROUP_OTHER,
         nameVi="Căn cước công dân bố (nếu có)", isOptional=True),
    dict(id="cccd-me-vo-chong", order=33, section=SECTION_DEPENDENTS, group=GROUP_OTHER,
         nameVi="Căn cước công dân mẹ (nếu có)", isOptional=True),
    dict(id="thu-ho-tro-bo-me", order=34, section=SECTION_DEPENDENTS, group=GROUP_OTHER,
         nameVi="Thư hỗ trợ từ bố mẹ (nếu có)", isOptional=True),
]
for _d in LOW_SKILL_ITEMS:
    _d["skillLevel"] = "LOW_SKILL"


# ============================================================================
# BỘ 2 — HIGH_SKILL (checklist "HIGH SKILLED – SINGLE" / "HIGH SKILLED – MARRIED")
# ============================================================================
HIGH_SKILL_APPLICANT_ITEMS = [
    # --- I. Giấy tờ cá nhân ---
    dict(id="hs-passport", order=1, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Passport",
         note="Cung cấp tất cả Passport từ trước đến nay",
         verificationNote="Xem lịch sử đi nước ngoài, nếu khách có đi bất hợp pháp thì yêu cầu "
                           "khách làm lại passport mới. Ngày hết hạn passport còn khoảng 1 năm "
                           "thì yêu cầu khách làm lại luôn."),
    dict(id="hs-cccd", order=2, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Căn cước công dân"),
    dict(id="hs-cmnd-cu", order=3, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Chứng minh nhân dân cũ (nếu có)",
         note="Cung cấp thêm giấy xác nhận đổi CMND (nếu có)", isOptional=True),
    dict(id="hs-tam-tru-ct07", order=4, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy xác nhận cư trú, mẫu CT07/CT08",
         verificationNote="Phải có đầy đủ thành viên trong gia đình (ba mẹ, anh chị em... con "
                           "cái). Phải còn thời hạn trong vòng 1 năm, phải đúng thông tin như "
                           "CCCD... Phải có dấu mộc đỏ của uỷ ban."),
    dict(id="hs-giay-khai-sinh", order=5, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy khai sinh",
         verificationNote="Thường kiểm tra ngày tháng năm sinh của cha mẹ có khớp không."),
    # Khác LOW_SKILL: checklist HIGH_SKILL nguồn liệt kê mục này ở CẢ bản SINGLE lẫn MARRIED
    # (appliesTo=ALWAYS) — không giới hạn theo SPOUSE như bên LOW_SKILL.
    dict(id="hs-dang-ky-ket-hon", order=6, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy đăng ký kết hôn (Nếu có)", isOptional=True),
    dict(id="hs-quyet-dinh-ly-hon", order=7, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy quyết định ly hôn (Nếu có)", isOptional=True),
    dict(id="hs-anh-the-phong-trang", order=8, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Ảnh thẻ phông trắng",
         note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh."),
    dict(id="hs-lltp-so-2", order=9, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp số 2",
         verificationNote="Hạn trong vòng 1 năm, phải có chữ ký điện tử và tên của cán bộ làm "
                           "giấy, phải khớp thông tin như CCCD, ngày cấp..."),
    dict(id="hs-lltp-nuoc-ngoai", order=10, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp tại nước ngoài (nếu có)", isOptional=True),
    dict(id="hs-giay-kham-suc-khoe", order=11, section=SECTION_APPLICANT, group=GROUP_PERSONAL,
         nameVi="Giấy khám sức khoẻ tại nơi chỉ định (nếu có)", isOptional=True,
         note="Tổ chức di cư quốc tế IOM"),

    # --- II. Giấy tờ chứng minh bằng cấp ---
    # Checklist HIGH_SKILL-MARRIED gốc KHÔNG có mục "Giấy xác nhận quá trình học tập" (chỉ
    # HIGH_SKILL-SINGLE có) — giữ đúng khác biệt này bằng appliesTo="SINGLE".
    dict(id="hs-giay-xac-nhan-qua-trinh-hoc-tap", order=12, section=SECTION_APPLICANT,
         group=GROUP_DEGREE, nameVi="Giấy xác nhận quá trình học tập", appliesTo="SINGLE"),
    dict(id="hs-bang-tot-nghiep-c2-c3", order=13, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bằng tốt nghiệp THCS / THPT",
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="hs-hoc-ba-c2-c3", order=14, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Học bạ THCS/ THPT", note="Nếu mất học bạ thì cung cấp bảng điểm học tập"),
    dict(id="hs-bang-trung-cap", order=15, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bằng Trung Cấp (Nếu có)", isOptional=True,
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="hs-bang-diem-trung-cap", order=16, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bảng điểm Trung Cấp (Nếu có)", isOptional=True),
    dict(id="hs-bang-cao-dang-dh", order=17, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bằng Cao Đẳng/ Đại học (Nếu có)", isOptional=True,
         verificationNote="Phải khớp với thực tế: khách có thể học trễ hơn 1 năm, nhưng không "
                           "được tốt nghiệp sớm so với tuổi thật."),
    dict(id="hs-bang-diem-cao-dang-dh", order=18, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Bảng điểm Cao Đẳng/ Đại học (Nếu có)", isOptional=True),
    dict(id="hs-chung-chi-nghe-khac", order=19, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Các bằng cấp/chứng chỉ nghề khác (Nếu có)", isOptional=True,
         note="Ví dụ: chứng chỉ nghề nail"),
    dict(id="hs-chung-chi-tieng-anh", order=20, section=SECTION_APPLICANT, group=GROUP_DEGREE,
         nameVi="Chứng chỉ thi tiếng Anh",
         verificationNote="Nếu thi online: ngày thi phải sau ngày cấp giấy xác nhận học tiếng "
                           "Anh tại trung tâm. Phải đúng với năng lực của khách — vd khách chỉ "
                           "học hết C2 thì không thể thi C1-C2; khách lớn tuổi khoảng B2; khách "
                           "có bằng ĐH thì C1 vẫn ổn. Giấy xác nhận học tại trung tâm: thời gian "
                           "học và trình độ phải hợp lý, phải có dấu xác nhận, song ngữ hoặc "
                           "tiếng Anh — không dùng giấy xác nhận chỉ bằng tiếng Việt."),

    # --- III. Giấy tờ chứng minh kinh nghiệm làm việc ---
    dict(id="hs-thu-xac-nhan-kinh-nghiem", order=21, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận kinh nghiệm làm việc"),
    dict(id="hs-thu-tai-tuyen-dung", order=22, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận tái tuyển dụng"),
    dict(id="hs-thu-xac-nhan-ubnd", order=23, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Thư xác nhận của UBND (nếu có)", isOptional=True),
    dict(id="hs-hop-dong-lao-dong", order=24, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Hợp đồng lao động"),
    dict(id="hs-phieu-luong", order=25, section=SECTION_APPLICANT, group=GROUP_WORK,
         nameVi="Phiếu lương / sao kê lương"),

    # --- IV. Giấy tờ chứng minh tài chính ---
    dict(id="hs-so-tiet-kiem", order=26, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Sổ tiết kiệm", note="Yêu cầu làm bản song ngữ Anh - Việt."),
    dict(id="hs-xac-nhan-so-du-tiet-kiem", order=27, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Giấy xác nhận số dư sổ tiết kiệm",
         note="Yêu cầu làm bản song ngữ Anh - Việt. Độc thân: tối thiểu 100-150 triệu. "
              "Đã kết hôn: tối thiểu 200-300 triệu. Kết hôn có 1 con: 350 triệu. "
              "Kết hôn 2 con: 400 triệu. Thêm 1 người thì tăng thêm 50 triệu.",
         verificationNote="Tuỳ theo khách mà bỏ số dư cho hợp lý."),
    dict(id="hs-quyen-su-dung-dat", order=28, section=SECTION_APPLICANT, group=GROUP_FINANCE,
         nameVi="Quyền sử dụng đất",
         note="Sao y công chứng tại văn phòng công chứng hoặc cơ quan nhà nước, không quá 1 tháng. "
              "Nếu không đứng tên trên sổ hồng/sổ đỏ thì lấy giấy tờ đất của bố mẹ ruột. "
              "Nếu đang thế chấp ngân hàng thì nhờ ngân hàng photo công chứng 1 bản."),
]

# --- V-VII. Hồ sơ người phụ thuộc (Vợ/chồng) — chỉ HIGH_SKILL-MARRIED, appliesTo=SPOUSE ---
HIGH_SKILL_SPOUSE_ITEMS = [
    dict(id="hs-spouse-passport", order=29, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Passport"),
    dict(id="hs-spouse-cccd", order=30, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Căn cước công dân"),
    dict(id="hs-spouse-cmnd", order=31, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Chứng minh nhân dân (Nếu có)", isOptional=True),
    dict(id="hs-spouse-khai-sinh", order=32, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Giấy khai sinh"),
    dict(id="hs-spouse-hinh-the-trang", order=33, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Hình thẻ trắng",
         note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh."),
    dict(id="hs-spouse-ly-hon", order=34, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Giấy quyết định ly hôn (Nếu có)", isOptional=True,
         note="Trường hợp vợ/chồng đã từng ly hôn thì bổ sung"),
    dict(id="hs-spouse-lltp2", order=35, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp số 2",
         verificationNote="Hạn trong vòng 1 năm, phải có chữ ký điện tử và tên của cán bộ làm "
                           "giấy, phải khớp thông tin như CCCD, ngày cấp..."),
    dict(id="hs-spouse-lltp-nuoc-ngoai", order=36, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Lý lịch tư pháp tại nước ngoài (nếu có)", isOptional=True),
    dict(id="hs-spouse-kham-suc-khoe", order=37, section=SECTION_SPOUSE, group=GROUP_PERSONAL,
         nameVi="Giấy khám sức khoẻ tại nơi chỉ định (nếu có)", isOptional=True,
         note="Tổ chức di cư quốc tế IOM"),

    dict(id="hs-spouse-bang-cao-nhat", order=38, section=SECTION_SPOUSE, group=GROUP_DEGREE,
         nameVi="Bằng cấp cao nhất"),
    dict(id="hs-spouse-hocba-bangdiem-cao-nhat", order=39, section=SECTION_SPOUSE, group=GROUP_DEGREE,
         nameVi="Học bạ/ bảng điểm cao nhất"),
    dict(id="hs-spouse-chung-chi-nghe-khac", order=40, section=SECTION_SPOUSE, group=GROUP_DEGREE,
         nameVi="Các bằng cấp/chứng chỉ nghề khác (Nếu có)", isOptional=True),
    dict(id="hs-spouse-chung-chi-tieng-anh", order=41, section=SECTION_SPOUSE, group=GROUP_DEGREE,
         nameVi="Chứng chỉ thi tiếng Anh (Nếu có)", isOptional=True),

    dict(id="hs-spouse-thu-xac-nhan-kinh-nghiem", order=42, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Thư xác nhận kinh nghiệm làm việc"),
    dict(id="hs-spouse-hop-dong-lao-dong", order=43, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Hợp đồng lao động"),
    dict(id="hs-spouse-phieu-luong", order=44, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Phiếu lương / sao kê lương"),
    dict(id="hs-spouse-so-tiet-kiem", order=45, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Sổ tiết kiệm (nếu có)", isOptional=True,
         note="Yêu cầu làm bản song ngữ Anh - Việt."),
    dict(id="hs-spouse-xac-nhan-so-du", order=46, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Giấy xác nhận số dư sổ tiết kiệm (nếu có)",
         isOptional=True, note="Yêu cầu làm bản song ngữ Anh - Việt."),
    dict(id="hs-spouse-quyen-su-dung-dat", order=47, section=SECTION_SPOUSE,
         group=GROUP_WORK_FINANCE, nameVi="Quyền sử dụng đất"),
]
for _d in HIGH_SKILL_SPOUSE_ITEMS:
    _d["appliesTo"] = "SPOUSE"


def _high_skill_child_items(child_number: int, start_order: int) -> list[dict]:
    """8 mục giống hệt nhau cho mỗi con (Con 1/2/3, mục VIII-XIII của checklist
    HIGH_SKILL-MARRIED gốc) — chỉ khác id/order/section/appliesTo theo số thứ tự con."""
    section = f"Hồ sơ người phụ thuộc (Con {child_number})"
    applies_to = f"SPOUSE_CHILD_{child_number}"
    prefix = f"hs-child{child_number}"
    return [
        dict(id=f"{prefix}-passport", order=start_order, section=section, group=GROUP_PERSONAL,
             nameVi="Passport", appliesTo=applies_to),
        dict(id=f"{prefix}-cccd", order=start_order + 1, section=section, group=GROUP_PERSONAL,
             nameVi="Căn cước công dân", appliesTo=applies_to),
        dict(id=f"{prefix}-khai-sinh", order=start_order + 2, section=section, group=GROUP_PERSONAL,
             nameVi="Giấy khai sinh", appliesTo=applies_to),
        dict(id=f"{prefix}-hinh-the-trang", order=start_order + 3, section=section, group=GROUP_PERSONAL,
             nameVi="Hình thẻ trắng",
             note="Kích thước: 3.5cm x 4.5cm. Chỉ cần gửi file hình, không cần rửa ra ảnh.",
             appliesTo=applies_to),
        dict(id=f"{prefix}-kham-suc-khoe", order=start_order + 4, section=section, group=GROUP_PERSONAL,
             nameVi="Giấy khám sức khoẻ tại nơi chỉ định (nếu có)", isOptional=True,
             note="Tổ chức di cư quốc tế IOM", appliesTo=applies_to),
        dict(id=f"{prefix}-xac-nhan-hoc-tap", order=start_order + 5, section=section, group=GROUP_DEGREE,
             nameVi="Giấy xác nhận quá trình học tập", appliesTo=applies_to),
        dict(id=f"{prefix}-bang-tot-nghiep", order=start_order + 6, section=section, group=GROUP_DEGREE,
             nameVi="Bằng tốt nghiệp THCS / THPT (nếu có)", isOptional=True, appliesTo=applies_to),
        dict(id=f"{prefix}-hoc-ba", order=start_order + 7, section=section, group=GROUP_DEGREE,
             nameVi="Học bạ THCS/ THPT (nếu có)", isOptional=True, appliesTo=applies_to),
    ]


HIGH_SKILL_CHILDREN_ITEMS = (
    _high_skill_child_items(1, 48) + _high_skill_child_items(2, 56) + _high_skill_child_items(3, 64)
)

HIGH_SKILL_ITEMS = HIGH_SKILL_APPLICANT_ITEMS + HIGH_SKILL_SPOUSE_ITEMS + HIGH_SKILL_CHILDREN_ITEMS
for _d in HIGH_SKILL_ITEMS:
    _d["skillLevel"] = "HIGH_SKILL"


CHECKLIST_ITEMS = LOW_SKILL_ITEMS + HIGH_SKILL_ITEMS


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

        # Dọn các mục cũ đã bị bỏ khỏi CHECKLIST_ITEMS (vd toàn bộ bộ checklist cũ trước khi
        # tách theo skillLevel) — để seed.py thực sự idempotent theo đúng nghĩa (state khớp
        # với danh sách hiện tại, không chỉ cộng dồn/cập nhật). Document.matchedChecklistItemId
        # có ondelete="SET NULL" nên an toàn khi xoá — document nào từng khớp mục bị xoá sẽ
        # tự chuyển về "chưa khớp", không lỗi.
        current_ids = {data["id"] for data in CHECKLIST_ITEMS}
        stale = db.scalars(select(ChecklistItem).where(ChecklistItem.id.notin_(current_ids))).all()
        for item in stale:
            db.delete(item)
        if stale:
            print(f"Removed {len(stale)} stale checklist item(s): {[i.id for i in stale]}")

        db.commit()
        print(
            f"Seeded {len(CHECKLIST_ITEMS)} checklist items "
            f"({len(LOW_SKILL_ITEMS)} LOW_SKILL + {len(HIGH_SKILL_ITEMS)} HIGH_SKILL)."
        )
    finally:
        db.close()


if __name__ == "__main__":
    main()
