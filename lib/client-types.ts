// Kiểu dữ liệu dùng ở client, khớp với JSON trả về từ backend FastAPI (backend/schemas.py).

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
  notes: string | null;
  tags: string[];
  createdAt: string;
  // null ở danh sách hồ sơ đang hoạt động — chỉ có giá trị ở /admin/cases (bao gồm cả hồ sơ
  // đã xoá mềm) hoặc /cases/deleted.
  deletedAt: string | null;
  percent: number;
  needsReviewCount: number;
  financialThreshold: FinancialThresholdDTO;
  expiredDocCount: number;
  expiringSoonDocCount: number;
}

export interface AdminStatsDTO {
  totalCases: number;
  activeCases: number;
  deletedCases: number;
  needsReviewDocuments: number;
  errorDocuments: number;
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
    notes: string | null;
    tags: string[];
    createdAt: string;
    documents: DocumentDTO[];
    aiAnalysisStatus: string;
    aiAnalysisSummary: string | null;
    aiAnalysisError: string | null;
    aiAnalysisUpdatedAt: string | null;
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
