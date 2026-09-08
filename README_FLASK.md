# Flask Server Setup

## Cài đặt

1. **Cài đặt dependencies:**
```bash
pip install -r requirements.txt
```

2. **Chạy server:**
```bash
python app.py
```

3. **Truy cập ứng dụng:**
- Mở browser: `http://localhost:5000`

## API Endpoints

- `GET /` - Trang chủ (load_data_only.html)
- `GET /api/health` - Kiểm tra server status
- `GET /api/tru/list` - Danh sách file JSON trong data/tru
- `GET /api/routes` - Dữ liệu routes (getroute.json)
- `GET /api/locations` - Dữ liệu locations (getlocation.json)
- `GET /api/cot-trung-tuyen/regions` - Danh sách regions cột trung thế

## Lưu ý

- Server chạy trên port 5000
- CORS đã được enable cho tất cả routes
- Debug mode được bật mặc định (tắt khi deploy production)
- Server tự động reload khi có thay đổi code (debug mode)

## Production Deployment

Để deploy production, thay đổi dòng cuối trong `app.py`:

```python
app.run(debug=False, host='0.0.0.0', port=5000)
```

Hoặc dùng production WSGI server như Gunicorn:

```bash
pip install gunicorn
gunicorn -w 4 -b 0.0.0.0:5000 app:app
```
