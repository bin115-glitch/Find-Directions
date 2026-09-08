import json
import os
import time
from selenium import webdriver
from selenium.webdriver.edge.options import Options
from selenium.webdriver.edge.service import Service
from selenium.webdriver.common.by import By
from generate_tru_index import generate_tru_index

def clean_json_file(file_path):
    """
    Làm sạch file JSON bằng cách loại bỏ các ký tự escape, khoảng trắng thừa,
    và format lại đúng chuẩn JSON.
    
    Args:
        file_path: Đường dẫn đến file JSON cần làm sạch
        
    Returns:
        True nếu thành công, False nếu thất bại
    """
    try:
        # Đọc nội dung file
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Kiểm tra nếu nội dung bị wrap trong dấu ngoặc kép (string-encoded JSON)
        if content.startswith('"') and content.endswith('"'):
            # Loại bỏ dấu ngoặc kép ngoài cùng
            content = content[1:-1]
            
            # Unescape chuỗi JSON
            content = content.replace('\\r\\n', '\n')
            content = content.replace('\\n', '\n')
            content = content.replace('\\"', '"')
            content = content.replace('\\\\', '\\')
        
        # Loại bỏ các ký tự \r\n hoặc khoảng trắng thừa
        content = content.replace('\r\n', '\n')
        content = content.replace('\r', '\n')
        
        # Parse JSON để validate
        try:
            json_data = json.loads(content)
        except json.JSONDecodeError as e:
            print(f"  ⚠️  Lỗi JSON decode: {e}")
            return False
        
        # Ghi lại file với format chuẩn
        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(json_data, f, ensure_ascii=False, indent=2)
        
        return True
        
    except Exception as e:
        print(f"  ❌ Lỗi xử lý file: {e}")
        return False

# Đường dẫn file input và output
GETBRANCH_FILE = "data/getbranch.json"
OUTPUT_DIR = "data/tru"

# Tạo thư mục output nếu chưa tồn tại
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Đọc dữ liệu từ getbranch.json
with open(GETBRANCH_FILE, "r", encoding="utf-8") as f:
    branch_data = json.load(f)

print(f"Tìm thấy {len(branch_data['Table'])} chi nhánh.")
print("=" * 60)

# Cấu hình Edge WebDriver
options = Options()

# Sử dụng driver local
service = Service(r"D:\download-31-12-25\find_directions\msedgedriver.exe")

print("\n🌐 Đang mở trình duyệt Edge...")

driver = None
try:
    # Khởi tạo driver với service
    driver = webdriver.Edge(service=service, options=options)
    
    # Mở trang đầu tiên để kiểm tra đăng nhập
    test_url = f"http://map.fpt.net/TRU/LoadObjectTRUByBranch?branchId={branch_data['Table'][0]['ID']}&cabType=5"
    driver.get(test_url)
    
    print("\n⏸️  DỪNG LẠI ĐỂ ĐĂNG NHẬP")
    print("=" * 60)
    print("📌 Nếu cần đăng nhập, hãy đăng nhập vào trang web trong trình duyệt.")
    print("📌 Sau khi đăng nhập xong và thấy dữ liệu JSON hiển thị,")
    print("📌 quay lại terminal này và bấm ENTER để bắt đầu tải dữ liệu.")
    print("=" * 60)
    
    input("\n👉 Bấm ENTER để tiếp tục... ")
    
    print("\n🚀 Bắt đầu tải dữ liệu...\n")
    
    # Duyệt qua từng branch
    for idx, branch in enumerate(branch_data["Table"], 1):
        branch_id = branch["ID"]
        branch_name = branch["NameBranch"]
        
        # Tạo tên file an toàn (loại bỏ ký tự đặc biệt)
        safe_filename = "".join(c if c.isalnum() or c in (' ', '-', '_') else '_' for c in branch_name)
        safe_filename = safe_filename.strip().replace(' ', '_')
        output_file = os.path.join(OUTPUT_DIR, f"{safe_filename}.json")
        
        print(f"[{idx}/{len(branch_data['Table'])}] {branch_name} (ID: {branch_id})")
        
        try:
            # Truy cập URL
            url = f"http://map.fpt.net/TRU/LoadObjectTRUByBranch?branchId={branch_id}&cabType=5"
            driver.get(url)
            
            # Đợi trang load
            time.sleep(1.5)
            
            # Lấy nội dung từ thẻ <pre> hoặc <body>
            try:
                page_text = driver.find_element(By.TAG_NAME, "pre").text
            except:
                page_text = driver.find_element(By.TAG_NAME, "body").text
            
            # Parse JSON
            json_data = json.loads(page_text)
            
            # Lưu vào file
            with open(output_file, "w", encoding="utf-8") as f:
                json.dump(json_data, f, ensure_ascii=False, indent=2)
            
            # Làm sạch file JSON (phòng trường hợp có ký tự lạ)
            if clean_json_file(output_file):
                print(f"  ✓ Đã lưu và làm sạch: {output_file}")
            else:
                print(f"  ✓ Đã lưu: {output_file} (không cần làm sạch)")
            
        except json.JSONDecodeError as e:
            print(f"  ✗ Lỗi parse JSON: {e}")
            # Lưu raw text để debug
            txt_file = output_file.replace('.json', '.txt')
            with open(txt_file, "w", encoding="utf-8") as f:
                f.write(page_text if 'page_text' in locals() else "No content")
            print(f"  ⚠ Đã lưu raw text: {txt_file}")
        except Exception as e:
            print(f"  ✗ Lỗi: {e}")
            continue
        
        # Nghỉ ngắn giữa các request
        time.sleep(0.3)
    
    print("\n" + "=" * 60)
    print("✅ Hoàn thành! Tất cả dữ liệu đã được tải về.")
    print(f"📁 Dữ liệu được lưu tại: {os.path.abspath(OUTPUT_DIR)}")
    print("=" * 60)
    
    # Hỏi người dùng có muốn làm sạch tất cả file JSON không
    print("\n🧹 Làm sạch tất cả file JSON trong thư mục?")
    print("   (Loại bỏ ký tự escape, khoảng trắng thừa, format lại)")
    clean_all = input("👉 Nhấn Y để làm sạch, hoặc Enter để bỏ qua: ").strip().upper()
    
    if clean_all == 'Y':
        print("\n🔄 Đang làm sạch tất cả file JSON...\n")
        json_files = [f for f in os.listdir(OUTPUT_DIR) if f.endswith('.json')]
        success_count = 0
        failed_count = 0
        
        for json_file in json_files:
            file_path = os.path.join(OUTPUT_DIR, json_file)
            print(f"Đang xử lý: {json_file}")
            
            if clean_json_file(file_path):
                print(f"  ✅ Đã làm sạch")
                success_count += 1
            else:
                print(f"  ⚠️  Không thể làm sạch")
                failed_count += 1
        
        print("\n" + "=" * 60)
        print(f"📊 Kết quả làm sạch:")
        print(f"  ✅ Thành công: {success_count} files")
        print(f"  ❌ Thất bại: {failed_count} files")
        print(f"  📁 Tổng số: {len(json_files)} files")
        print("=" * 60)
    
    # Tự động tạo index file cho load_data_only.html
    print("\n🔄 Đang tạo index file...")
    try:
        generate_tru_index()
    except Exception as e:
        print(f"⚠️  Lỗi khi tạo index: {e}")
    
finally:
    # Đóng browser nếu đã khởi tạo
    if driver is not None:
        print("\n🔒 Đang đóng trình duyệt...")
        try:
            driver.quit()
            print("✓ Đã đóng trình duyệt.")
        except:
            pass
