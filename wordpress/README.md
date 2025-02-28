
# Edge Cache Worker with KV cho Wordpress

Đây là một Cloudflare Worker sử dụng KV làm cache cho các HTML GET requests. Script này sẽ:
- Tự động cache nội dung HTML khi nhận được các request GET thành công.
- Hỗ trợ bypass cache nếu có các cookie nhất định (mặc định: `wp-`, `wordpress`, `comment_`, `woocommerce_`).
- Cho phép purge cache bằng cách tăng phiên bản (cache version) lưu trữ trên KV.
- Thêm header `x-worker-health` vào response để kiểm tra trạng thái hoạt động của Worker.

## Tính năng

- **Caching HTML**: Cache các request HTML GET thành công nhằm giảm tải cho server gốc.
- **Bypass Cookie**: Tự động bypass cache nếu request chứa các cookie theo định dạng đã chỉ định.
- **Stale-While-Revalidate**: Khi có cached response, Worker trả về kết quả từ cache và bất đồng bộ cập nhật cache nếu cần.
- **Edge Cache Purge**: Purge cache thông qua việc tăng phiên bản lưu trên KV.
- **Health Check**: Thêm header `x-worker-health: active` vào response, cho phép dễ dàng kiểm tra trạng thái của Worker.

## Yêu cầu

- **Cloudflare Worker**: Cần có tài khoản Cloudflare và quyền truy cập vào Cloudflare Workers.
- **KV Namespace**: Phải bind một KV Namespace với biến `EDGE_CACHE`. Không cần cấu hình API của Cloudflare (đã loại bỏ hoàn toàn).

## Cài đặt và Cấu hình

1. **Cài đặt Wrangler CLI**  
   Nếu bạn chưa cài đặt, hãy tham khảo tài liệu của [Wrangler](https://developers.cloudflare.com/workers/wrangler/get-started/) để cài đặt công cụ quản lý Worker.

2. **Tạo file `wrangler.toml`**  
   Tạo file `wrangler.toml` trong thư mục dự án và cấu hình như sau:

   ```toml
   name = "edge-cache-worker"
   type = "javascript"

   kv_namespaces = [
     { binding = "EDGE_CACHE", id = "YOUR_KV_NAMESPACE_ID" }
   ]
   ```

   **Lưu ý:** Thay `YOUR_KV_NAMESPACE_ID` bằng ID của KV Namespace bạn đã tạo trên Cloudflare.

3. **Đưa đoạn code vào dự án**  
   Sao chép đoạn mã của Worker (đã tối ưu) vào file chính của dự án (ví dụ: `index.js` hoặc `worker.js`).

## Triển khai

Sau khi đã cấu hình đầy đủ:

1. Chạy lệnh kiểm tra dự án:
   ```bash
   wrangler dev
   ```
   Lệnh này sẽ khởi chạy một phiên bản phát triển của Worker tại địa chỉ cục bộ để bạn kiểm tra.

2. Triển khai lên Cloudflare:
   ```bash
   wrangler publish
   ```

## Hướng dẫn sử dụng

- **Caching HTML Requests:**  
  Khi Worker nhận được một request GET với header `Accept` chứa `text/html`, nó sẽ kiểm tra cache. Nếu có dữ liệu cache hợp lệ và không có cookie bypass, Worker sẽ trả về cached response kèm các header:
  - `x-HTML-Edge-Cache-Status`
  - `x-HTML-Edge-Cache-Version`
  - `CF-Cache-Status` (nếu có cached response từ origin)

- **Purge Cache:**  
  Nếu response từ origin có chỉ thị purge (các command như `purgeall` trong header `x-HTML-Edge-Cache`), Worker sẽ tự động tăng phiên bản cache và cập nhật KV.

- **Kiểm tra trạng thái Worker:**  
  Mỗi response HTML thành công sẽ có thêm header:
  ```http
  x-worker-health: active
  ```
  Bạn có thể dùng header này để kiểm tra xem Worker có đang hoạt động hay không.

## Cấu trúc Code

- **Main Event Listener:**  
  Lắng nghe sự kiện `fetch` và kiểm tra xem yêu cầu có phù hợp xử lý (không phải request hình ảnh, không có cache từ upstream, v.v...) không.

- **processRequest:**  
  Hàm xử lý chính: gửi request lên origin, cache kết quả nếu cần, hoặc trả về cached response và cập nhật cache bất đồng bộ.

- **Caching & Purge Functions:**  
  Bao gồm các hàm như `getCachedResponse`, `cacheResponse`, `purgeCache`, `updateCache` và các hàm tiện ích để xử lý cache version từ KV.

- **Bypass Logic:**  
  Hàm `shouldBypassEdgeCache` kiểm tra cookie của request để xác định có cần bypass cache hay không.

## Ghi chú

- Đảm bảo rằng KV Namespace đã được bind với tên biến `EDGE_CACHE` theo đúng cấu hình trong `wrangler.toml`.
- Chỉ hỗ trợ caching cho các request HTML GET, các loại request khác sẽ được chuyển tiếp trực tiếp tới origin.
- Trong môi trường phát triển, hãy kiểm tra kỹ header `x-worker-health` để xác nhận Worker đang hoạt động.

## License

Dự án này được cung cấp theo giấy phép MIT. Bạn có thể tự do sử dụng và chỉnh sửa mã nguồn cho mục đích cá nhân hoặc thương mại.