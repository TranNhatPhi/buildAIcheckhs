export function GeneralNotesBanner() {
  return (
    <div className="bg-blue-50 border-2 border-blue-100 rounded-2xl p-5 text-sm text-blue-900 flex flex-col gap-1.5">
      <p className="font-bold">Lưu ý chung khi thu hồ sơ:</p>
      <ul className="list-disc list-inside space-y-1">
        <li>
          Tất cả giấy tờ phải là bản gốc, scan màu bằng máy scan hoặc tại cửa hàng photocopy —
          tuyệt đối không chụp hình bằng điện thoại.
        </li>
        <li>
          Giấy tờ nhà đất cần sao y công chứng tại văn phòng công chứng hoặc cơ quan nhà nước,
          không quá 1 tháng tính đến thời điểm nộp.
        </li>
      </ul>
    </div>
  );
}
