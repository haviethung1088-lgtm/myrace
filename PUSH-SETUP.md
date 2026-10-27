# Cấu hình thông báo đẩy dùng chung cho My Race

## Tạo Worker một lần

1. Trong Cloudflare, tạo một Worker mới và dán toàn bộ nội dung `worker.js` vào phần mã nguồn, sau đó Deploy.
2. Tạo một KV namespace và gắn vào Worker với binding name chính xác là `KV`.
3. Trong phần Triggers, thêm Cron Trigger `* * * * *` để Worker kiểm tra lịch mỗi phút. Mỗi thiết bị được nhắc theo múi giờ của chính thiết bị đó.
4. Worker mặc định chỉ nhận yêu cầu từ `https://haviethung1088-lgtm.github.io`. Nếu GitHub Pages dùng domain khác, đặt biến `APP_ORIGIN` thành đúng origin của trang (chỉ gồm giao thức và tên miền, không có đường dẫn).
5. Mở `https://TEN-WORKER.TEN-TK.workers.dev/health`. Kết quả cần có `{"ok":true}`.
6. Sao chép URL gốc `https://TEN-WORKER.TEN-TK.workers.dev` vào dòng `MY_RACE_PUSH_URL` trong `push-config.js`. Không đặt API_KEY hay secret trong file này; Worker tự tạo và lưu khóa Web Push trong KV.
7. Đưa các file app lên GitHub Pages. Người dùng mở app, bật thông báo một lần và cho phép trình duyệt gửi thông báo. Không cần nhập URL, mã bí mật hoặc chọn giờ. Dự báo thời tiết trong lời chào 08:00 là tùy chọn riêng, mặc định tắt. Khi bật, app gửi tọa độ thời tiết đã lưu (làm tròn khoảng 1 km) tới Worker; Worker lưu vị trí trong KV để lấy dự báo Open-Meteo. Người dùng có thể tắt tùy chọn để xóa vị trí khỏi đăng ký.

## Lịch gửi

- 20:00: nhắc buổi tập hoặc cuộc đua ngày mai nếu lịch có hoạt động.
- 00:00: nhắc buổi tập hoặc thi đấu nếu lịch hôm nay có hoạt động.
- 08:00: lời chào hằng ngày, kể cả ngày nghỉ; có thêm tóm tắt trời, nhiệt độ, khả năng mưa và gió nếu người dùng đã đồng ý chia sẻ vị trí.

App tự đồng bộ lịch khi mở và sau khi lịch tập được lưu. Thiết bị cần có kết nối mạng để đăng ký/cập nhật; trình duyệt phải hỗ trợ Web Push. Trên iPhone cần iOS 16.4 trở lên và mở app đã thêm vào Màn hình chính.
