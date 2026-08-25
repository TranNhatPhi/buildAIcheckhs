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
}

export interface DocumentDTO {
  id: string;
  caseId: string;
  originalFilename: string;
  storedPath: string;
  mimeType: string;
  fileSizeBytes: number;
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

export interface CaseListItemDTO {
  id: string;
  clientName: string;
  maritalStatus: string;
  numberOfChildren: number;
  notes: string | null;
  createdAt: string;
  // null ở danh sách hồ sơ đang hoạt động — chỉ có giá trị ở /admin/cases (bao gồm cả hồ sơ
  // đã xoá mềm) hoặc /cases/deleted.
  deletedAt: string | null;
  percent: number;
  needsReviewCount: number;
  financialThreshold: FinancialThresholdDTO;
}

export interface AdminStatsDTO {
  totalCases: number;
  activeCases: number;
  deletedCases: number;
  needsReviewDocuments: number;
  errorDocuments: number;
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
    notes: string | null;
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
}
