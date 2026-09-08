import argparse
import json
from pathlib import Path
from typing import Iterable


def normalize_json_content(content: str):
    """Convert a JSON file that may be stored as a string-wrapped payload into a standard object."""
    text = content.strip()
    if not text:
        raise ValueError("empty content")

    # First try normal JSON parsing.
    try:
        parsed = json.loads(text)
        if isinstance(parsed, (dict, list)):
            return parsed
    except json.JSONDecodeError:
        pass

    # Some files are stored as a JSON string containing another JSON document.
    if (text.startswith('"') and text.endswith('"')) or (text.startswith("'") and text.endswith("'")):
        try:
            inner = json.loads(text)
        except json.JSONDecodeError:
            inner = text[1:-1]

        current = inner
        for _ in range(5):
            if isinstance(current, str):
                stripped = current.strip()
                try:
                    current = json.loads(stripped)
                except json.JSONDecodeError:
                    break
            else:
                break

        if isinstance(current, (dict, list)):
            return current

    raise ValueError("content is not valid JSON or a wrapped JSON string")


def clean_json_file(file_path: str | Path):
    path = Path(file_path)
    content = path.read_text(encoding="utf-8")
    data = normalize_json_content(content)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return data


def discover_ring_files(root: Path) -> Iterable[Path]:
    return sorted(root.glob("Axis_id=*.json"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Clean ring JSON files to standard pretty-printed JSON")
    parser.add_argument("paths", nargs="*", help="Specific JSON files to clean")
    parser.add_argument("--all-ring", action="store_true", help="Clean all ring JSON files under data/ring")
    args = parser.parse_args()

    root = Path(__file__).resolve().parent.parent
    if args.all_ring:
        targets = list(discover_ring_files(root / "data" / "ring"))
    elif args.paths:
        targets = [Path(p) for p in args.paths]
        targets = [p if p.is_absolute() else (root / p) for p in targets]
    else:
        targets = [root / "data" / "ring" / "Axis_id=552.json"]

    if not targets:
        print("No target files found")
        raise SystemExit(1)

    for target in targets:
        if not target.exists():
            print(f"Skip missing file: {target}")
            continue
        try:
            clean_json_file(target)
            print(f"Cleaned: {target.relative_to(root)}")
        except Exception as exc:
            print(f"Failed: {target.relative_to(root)} -> {exc}")
