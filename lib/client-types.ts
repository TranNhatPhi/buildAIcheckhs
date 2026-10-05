// Kiểu dữ liệu dùng ở client, khớp với JSON trả về từ backend FastAPI (backend/schemas.py).

export type ApplicationStatus =
  | "PENDING"
  | "COLLECTING_DOCUMENTS"
  | "REVIEWING_DOCUMENTS"
  | "READY_TO_SUBMIT"
  | "COMPLETED"
  | "SUBMITTED"
  | "APPROVED"
  | "REJECTED"
  | "LIQUIDATED";

export interface ChecklistItemDTO {
  id: string;
  order: number;
  section: string;
  group: string;
  nameVi: string;
  note: string | null;
  verificationNote: string | null;
  isOptional: boolean;
  appliesTo: string;
  quantityRule: string;
  skillLevel: string;
  /** Các mục cùng giá trị này, nằm liền nhau, dùng chung số lớn: "18.1", "18.2". */
  numberGroup: string | null;
}

export interface DocumentDTO {
  id: string;
  caseId: string;
  originalFilename: string;
  storedPath: string;
  mimeType: string;
  fileSizeBytes: number;
  pageCount: number | null;
  uploadedAt: string;
  matchedChecklistItemId: string | null;
  matchedChecklistItem: ChecklistItemDTO | null;
  ocrText: string | null;
  correctedText: string | null;
  manualCorrectedText: string | null;
  aiRawLabel: string | null;
  aiConfidence: number | null;
  aiReasoning: string | null;
  status: "PENDING" | "OCR_RUNNING" | "CLASSIFYING" | "CLASSIFIED" | "NEEDS_REVIEW" | "MANUALLY_SET" | "ERROR";
  classificationError: string | null;
  isManualOverride: boolean;

  // Thông tin AI bóc ra từ chính giấy tờ, lấy kèm trong lệnh phân loại (xem backend/classify.py).
  aiDocOwner: string | null;
  aiHolderName: string | null;
  aiHolderDob: string | null;
  aiIdNumber: string | null;
  aiIdType: string | null;
  aiIssuedAt: string | null;
  aiExpiresAt: string | null;
  // Ngày nhân viên sửa tay khi AI đọc sai — được ưu tiên hơn aiExpiresAt.
  manualExpiresAt: string | null;
  aiFieldsNote: string | null;
}

export interface DocExpiryDTO {
  documentId: string;
  filename: string;
  itemName: string | null;
  expiresAt: string;
  source: "MANUAL" | "AI";
  /** Âm nghĩa là đã quá hạn. */
  daysLeft: number;
  state: "EXPIRED" | "EXPIRING_SOON";
}

export interface DataConflictDTO {
  owner: string;
  ownerLabel: string;
  fieldLabel: string;
  values: { value: string; filename: string }[];
}

export interface DocChecksDTO {
  expiries: DocExpiryDTO[];
  conflicts: DataConflictDTO[];
  expiredCount: number;
  expiringSoonCount: number;
  warnDays: number;
}

export interface ChecklistItemStatusDTO {
  item: ChecklistItemDTO;
  requiredCount: number;
  fulfilledCount: number;
  complete: boolean;
  matchedDocuments: DocumentDTO[];
}

export interface FinancialThresholdDTO {
  minVND: number;
  maxVND: number;
  isEstimated: boolean;
}

/** Số dư tiết kiệm thật của khách, đối chiếu với mức yêu cầu ở financialThreshold. */
export interface SavingsAssessmentDTO {
  aiVnd: number | null;
  aiNote: string | null;
  manualVnd: number | null;
  /** Số dùng để kết luận: manualVnd nếu nhân viên đã nhập, không thì aiVnd. */
  effectiveVnd: number | null;
  source: "MANUAL" | "AI" | "NONE";
  verdict: "ENOUGH" | "BORDERLINE" | "SHORT" | "UNKNOWN";
  shortOfMinVnd: number;
  shortOfMaxVnd: number;
  updatedAt: string | null;
}

export interface CaseListItemDTO {
  id: string;
  clientName: string;
  maritalStatus: string;
  numberOfChildren: number;
  skillLevel: string;
  /** Đối tác / nguồn giới thiệu. null = khách tự tìm đến, hoặc hồ sơ tạo trước khi có trường này. */
  partner: string | null;
  /** Người phụ trách hồ sơ — ô chữ tự do, null = chưa nhập. */
  receiverName: string | null;
  managerName: string | null;
  saleName: string | null;
  /** Nghề nghiệp của đương đơn, vd "Xây dựng", "Chế biến hải sản". */
  occupation: string | null;
  /** Kinh nghiệm quy về SỐ THÁNG. Dùng formatExperience() để hiển thị. */
  experienceMonths: number | null;
  experienceUnits: ExperienceUnit[];
  notes: string | null;
  tags: string[];
  createdAt: string;
  applicationStatus: ApplicationStatus;
  applicationStatusUpdatedAt: string | null;
  lastStatusReminderAt: string | null;
  nextStatusReminderAt: string | null;
  statusReminderDue: boolean;
  statusReminderIntervalDays: number;
  // 1 = lần đầu; > 1 = admin đã cho nộp lại (hiện "Nộp lại lần N" cạnh tên).
  submissionRound: number;
  // Lần có file mới gần nhất (null = chưa có file) — cột "Ngày cập nhật" ở trang thống kê.
  lastDocumentAt: string | null;
  // Số ngày chưa cập nhật nếu thuộc diện nhắc "7 ngày chưa cập nhật" (backend thong_bao.py), null nếu không.
  // Chỉ có ở danh sách (GET /cases, GET /admin/cases).
  idleDays?: number | null;
  // null ở danh sách hồ sơ đang hoạt động — chỉ có giá trị ở /admin/cases (bao gồm cả hồ sơ
  // đã xoá mềm) hoặc /cases/deleted.
  deletedAt: string | null;
  /** Mốc admin bấm "Đánh dấu hoàn tất"; null = chưa đánh dấu. Chỉ endpoint admin trả về. */
  completedAt: string | null;
  /** Mốc hồ sơ sẽ tự xoá mềm (= completedAt + 15 ngày). */
  autoDeleteAt: string | null;
  /** Lúc file giấy tờ bị xoá sạch sau khi hoàn tất; null = file vẫn còn. Khách hàng vẫn giữ. */
  filesPurgedAt: string | null;
  percent: number;
  needsReviewCount: number;
  financialThreshold: FinancialThresholdDTO;
  expiredDocCount: number;
  expiringSoonDocCount: number;
  // Chỉ PATCH /cases/{id} mới trả về true: lần đổi trạng thái vừa rồi có kích hoạt email báo
  // tức thì hay không. Backend quyết định (INSTANT_EMAIL_STATUSES), frontend chỉ hiển thị —
  // đừng tự dựng lại danh sách trạng thái ở đây, sẽ lệch.
  statusEmailQueued?: boolean;
}

export interface AdminStatsDTO {
  totalCases: number;
  activeCases: number;
  deletedCases: number;
  needsReviewDocuments: number;
  errorDocuments: number;
  pendingDecisionCases: number;
  statusRemindersDue: number;
  expiredDocuments: number;
  expiringSoonDocuments: number;
  /** Khoá là ApplicationStatus, chỉ có mặt trạng thái đang thật sự có hồ sơ. */
  casesByStatus: Record<string, number>;
  /** Khoá là tên nhãn (GẤP, VIP...), chỉ có mặt nhãn đang được dùng. */
  casesByTag: Record<string, number>;
}

/** Một dòng hồ sơ bên trong email đã gửi. */
export interface EmailLogCaseRowDTO {
  client_name: string;
  status_label: string;
  status_color: string;
  updated_at: string;
  case_url: string;
}

/** Nhật ký email, lấy từ GET /admin/email-logs. */
export interface EmailLogDTO {
  id: string;
  createdAt: string;
  /** "STATUS_CHANGE" | "PERIODIC_REMINDER" | "TEST" */
  trigger: string;
  caseId: string | null;
  caseClientName: string | null;
  applicationStatus: string | null;
  title: string;
  intro: string | null;
  footer: string | null;
  cases: EmailLogCaseRowDTO[];
  recipient: string | null;
  /** "SENT" | "FAILED" */
  status: string;
  errorMessage: string | null;
}

export interface AdminDocumentDTO extends DocumentDTO {
  caseClientName: string;
  caseDeletedAt: string | null;
}

export interface CaseAnalysisResponse {
  summary: string;
}

export interface CaseDetailDTO {
  case: {
    id: string;
    clientName: string;
    maritalStatus: string;
    numberOfChildren: number;
    skillLevel: string;
    partner: string | null;
    receiverName: string | null;
    managerName: string | null;
    saleName: string | null;
    occupation: string | null;
    experienceMonths: number | null;
    experienceUnits: ExperienceUnit[];
    notes: string | null;
    tags: string[];
    createdAt: string;
    applicationStatus: ApplicationStatus;
    applicationStatusUpdatedAt: string | null;
    lastStatusReminderAt: string | null;
    nextStatusReminderAt: string | null;
    statusReminderDue: boolean;
    statusReminderIntervalDays: number;
    submissionRound: number;
    lastDocumentAt: string | null;
    documents: DocumentDTO[];
    aiAnalysisStatus: string;
    aiAnalysisSummary: string | null;
    aiAnalysisError: string | null;
    aiAnalysisUpdatedAt: string | null;
    completedAt: string | null;
    autoDeleteAt: string | null;
    filesPurgedAt: string | null;
  };
  checklist: {
    items: ChecklistItemStatusDTO[];
    percent: number;
    totalRequiredItems: number;
    completedRequiredItems: number;
    needsReviewCount: number;
  };
  financialThreshold: FinancialThresholdDTO;
  savings: SavingsAssessmentDTO;
  docChecks: DocChecksDTO;
}

/** Tag hợp lệ + màu hiển thị, lấy từ GET /cases/tags. */
export interface TagDefinition {
  name: string;
  color: string;
}

/** Một file trong kết quả POST /translation-check (xem backend/routers/translation_check.py). */
export interface TranslationFileDTO {
  /** Tên file đã sửa lỗi mã hoá (vd "Ho╠é╠Ç" -> "Hồ") nếu có. */
  filename: string;
  /** Chủ giấy tờ đọc từ tên file theo quy ước "<số>. <Họ tên> - <loại>"; null nếu không theo quy ước. */
  ownerName: string | null;
  ownerForm: string | null;
  chars: number;
  error: string | null;
  /** Tên đọc được trong bản dịch, kèm vai trò nếu xác định được: "HO XUAN TINH (chủ hộ)". */
  names: string[];
  idNumbers: string[];
  /** Chữ app đọc được từ bản dịch (cắt bớt nếu quá dài) — dùng cho khung xem nhanh. */
  text: string;
  /** Đường dẫn mở file gốc đã lưu trên MinIO (ghép sau API_URL); null nếu lưu hỏng. */
  url: string | null;
}

export interface TranslationFindingDTO {
  severity: "ERROR" | "WARNING";
  rule: string;
  title: string;
  message: string;
  files: string[];
}

export interface TranslationCheckResponse {
  applicantName: string;
  /** Họ tên dạng chuẩn trong bản dịch: viết HOA, bỏ dấu. */
  expectedName: string;
  /** Mã lượt kiểm tra = tên thư mục giữ bộ bản dịch này trên MinIO. */
  checkId: string;
  files: TranslationFileDTO[];
  findings: TranslationFindingDTO[];
  summary: { files: number; readable: number; errors: number; warnings: number };
}

/** Đơn vị (công ty) xác nhận kinh nghiệm + ngày trên giấy xác nhận ("YYYY-MM-DD"). */
export interface ExperienceUnit {
  name: string;
  confirmedDate: string | null;
}
