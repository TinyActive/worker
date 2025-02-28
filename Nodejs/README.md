# Cloudflare Worker – HTML Edge Cache Cho Nodejs

Đây là một Worker được thiết kế để cache nội dung HTML GET requests trên Edge của Cloudflare, đồng thời hỗ trợ việc purge chỉ phần HTML cache thông qua một KV Namespace được bind với biến **EDGE_CACHE**.

## Nội dung chính

- [Tính năng](#tính-năng)
- [Yêu cầu](#yêu-cầu)
- [Cài đặt và cấu hình](#cài-đặt-và-cấu-hình)
- [Cách thức hoạt động](#cách-thức-hoạt-động)
- [Chi tiết các hàm chính](#chi-tiết-các-hàm-chính)
- [Quản lý cache và purge](#quản-lý-cache-và-purge)
- [Cách sử dụng](#cách-sử-dụng)
- [Lưu ý](#lưu-ý)

## Tính năng

- **Cache HTML GET Requests:** Chỉ cache các request có phương thức GET và có header `Accept` chứa `text/html`.
- **Tự động xử lý cache và purge:** Khi response từ origin chứa header chỉ thị `x-HTML-Edge-Cache`, Worker sẽ xử lý cache và cho phép purge cache nếu cần.
- **Bypass cache dựa trên cookie:** Có thể bypass cache nếu cookie của request chứa các tiền tố nhất định (mặc định: `wp-`, `nodejs`, `comment_`, `shop_`).
- **Quản lý phiên bản cache:** Phiên bản cache được lưu trong KV Namespace (EDGE_CACHE) để cho phép purge các nội dung HTML cũ mà không cần xóa toàn bộ cache.
- **Thêm header thông báo trạng thái:** Mỗi response đều có thêm header `X-Worker-Status: Active` và các header liên quan đến trạng thái cache.

## Yêu cầu

- **Cloudflare Worker:** Tài khoản Cloudflare có quyền tạo và quản lý Worker.
- **KV Namespace:** Phải tạo một KV Namespace và bind với biến môi trường `EDGE_CACHE`. KV này sẽ lưu trữ phiên bản cache cho HTML.
- **Cache API:** Worker sử dụng cache mặc định của Cloudflare.

## Cài đặt và cấu hình

1. **Tạo KV Namespace:**
   - Truy cập vào dashboard của Cloudflare Workers.
   - Tạo một KV Namespace mới (ví dụ: `HTML_EDGE_CACHE`).
   - Trong cấu hình của Worker, bind namespace vừa tạo với tên biến là `EDGE_CACHE`.

2. **Triển khai Worker:**
   - Sử dụng [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) để phát triển và deploy Worker.
   - Cấu hình file `wrangler.toml` với thông tin cần thiết và khai báo binding KV. Ví dụ:

   ```toml
   name = "html-edge-cache-worker"
   type = "javascript"
   
   [vars]
   # Có thể cấu hình các biến môi trường khác tại đây nếu cần
   
   [[kv_namespaces]]
   binding = "EDGE_CACHE"
   id = "your-kv-namespace-id"
   preview_id = "your-kv-preview-namespace-id"
   ```

3. **Deploy:**
   - Chạy lệnh `wrangler publish` để deploy Worker lên Cloudflare.

## Cách thức hoạt động

1. **Phân loại request:**
   - Nếu request không phải GET hoặc không chứa `text/html` trong header `Accept`, Worker sẽ chỉ fetch từ origin mà không thực hiện cache.
   - Với GET HTML requests, Worker sẽ kiểm tra xem đã có cached response chưa.

2. **Cache logic:**
   - Gọi hàm `getCachedResponse`: Nếu có cached response và không bị bypass do cookie, trả về cached content.
   - Nếu không có cached response, hoặc bị bypass, Worker sẽ clone request, thêm header `x-HTML-Edge-Cache` chỉ thị xử lý cache và fetch từ origin.
   - Sau khi nhận response từ origin, nếu response hợp lệ (GET, status 200, HTML), Worker sẽ lưu vào cache sau khi xử lý header liên quan đến cache.

3. **Purge và cập nhật phiên bản cache:**
   - Nếu response từ origin có header chỉ thị `purgeall` trong `x-HTML-Edge-Cache`, phiên bản cache sẽ được tăng lên và lưu vào KV.
   - Mỗi cache key được version hoá thông qua việc thêm query parameter `cf_edge_cache_ver`.

4. **Cập nhật header response:**
   - Mỗi response đều được bổ sung thêm header `X-Worker-Status: Active` và thông tin cache như `x-HTML-Edge-Cache-Status`, `x-HTML-Edge-Cache-Version` và `CF-Cache-Status` (nếu có).

## Chi tiết các hàm chính

- **handleRequest(event):**  
  Xác định loại request và gọi các hàm xử lý tương ứng (cache hoặc fetch).

- **processRequest(request, event):**  
  Xử lý logic cache cho GET HTML requests. Gọi hàm `getCachedResponse`, `cacheResponse`, và cập nhật cache khi cần.

- **getCachedResponse(request):**  
  Kiểm tra cache cho HTML GET requests và trả về đối tượng gồm cached response, phiên bản cache, trạng thái cache, và thông tin bypass.

- **cacheResponse(cacheVer, request, originalResponse, event):**  
  Cache nội dung response sau khi loại bỏ các header không cần thiết và lưu thông tin cache qua Cache API.

- **updateCache(originalRequest, cacheVer, event):**  
  Cập nhật cache bất đồng bộ khi đã có cached response nhưng muốn refresh dữ liệu.

- **purgeCache(cacheVer, event):**  
  Tăng phiên bản cache bằng cách lưu vào KV Namespace, giúp purge nội dung cache cũ.

- **shouldBypassEdgeCache(request, response):**  
  Kiểm tra cookie của request để quyết định có nên bypass cache hay không.

- **getResponseOptions(response):**  
  Phân tích header `x-HTML-Edge-Cache` để lấy các lệnh: cache, purge và bypass cookies.

- **GetCurrentCacheVersion(cacheVer):**  
  Lấy phiên bản cache hiện tại từ KV. Nếu chưa có, sẽ khởi tạo với giá trị 0.

- **GenerateCacheRequest(request, cacheVer):**  
  Sinh ra Request đã được version hoá dựa vào URL và phiên bản cache để quản lý cache hiệu quả.

## Quản lý cache và purge

- **Phiên bản cache:**  
  Mỗi request cache được lưu với một phiên bản cache hiện tại được lấy từ KV (`html_cache_version`). Khi cần purge (ví dụ khi response chỉ thị `purgeall`), phiên bản cache được tăng lên, từ đó các cache cũ sẽ không được dùng nữa.

- **Purge thông qua KV:**  
  Khi purge xảy ra, Worker sẽ gọi hàm `purgeCache` để cập nhật phiên bản cache trong KV, cho phép loại bỏ nội dung HTML cũ mà không ảnh hưởng đến các nội dung khác.

## Cách sử dụng

- **Deploy Worker:**  
  Sau khi đã cấu hình và bind KV Namespace, deploy Worker lên Cloudflare. Mọi GET request HTML sẽ được xử lý theo logic cache đã được định nghĩa.

- **Tùy chỉnh header cache:**  
  Nếu cần thiết, có thể cấu hình thêm hoặc thay đổi logic xử lý header thông qua việc sửa đổi hàm `getResponseOptions`.

- **Theo dõi log:**  
  Các header trạng thái cache (`x-HTML-Edge-Cache-Status`, `x-HTML-Edge-Cache-Version`) giúp bạn theo dõi hoạt động của cache cho từng request.

## Lưu ý

- **KV Namespace Binding:**  
  Đảm bảo rằng bạn đã bind đúng KV Namespace với biến `EDGE_CACHE` trong cấu hình Worker. Nếu không, phiên bản cache sẽ không được lưu trữ và các chức năng purge sẽ không hoạt động.

- **Bypass Cookies:**  
  Danh sách cookie mặc định có thể được thay đổi thông qua header `x-HTML-Edge-Cache` của response. Điều này cho phép linh hoạt trong việc bypass cache khi cần thiết.

- **Cache API:**  
  Worker sử dụng `caches.default` của Cloudflare. Việc quản lý cache phụ thuộc vào điều kiện của request (GET, HTML, status 200) và các header cấu hình.

