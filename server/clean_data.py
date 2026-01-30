import json
import os

DATA_FILE = r'd:/repo/tupiantranslator/server/user_data.json'

def normalize(text):
    # Normalize by removing whitespace effectively ignores differences in line breaks
    return text.replace('\n', '').replace(' ', '').strip()

def clean_duplicates():
    if not os.path.exists(DATA_FILE):
        print(f"File not found: {DATA_FILE}")
        return

    try:
        with open(DATA_FILE, 'r', encoding='utf-8') as f:
            data = json.load(f)

        if 'global' in data:
            items = data['global']
            original_count = len(items)
            
            seen_originals = set()
            clean_items = []
            duplicates_count = 0
            
            print("--- Starting Cleanup ---")
            for orig, trans in items:
                norm_orig = normalize(orig)
                
                # Check for duplicate
                if norm_orig in seen_originals:
                    duplicates_count += 1
                    print(f"🗑️  Removing Duplicate: {orig[:20].replace(chr(10), ' ')}... -> {trans[:20]}...")
                    continue
                
                seen_originals.add(norm_orig)
                clean_items.append([orig, trans])
            
            data['global'] = clean_items
            
            # Write back
            if duplicates_count > 0:
                with open(DATA_FILE, 'w', encoding='utf-8') as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"\n✅ Cleanup Complete!")
                print(f"📊 Stats: {original_count} -> {len(clean_items)} (Removed {duplicates_count} duplicates)")
            else:
                print("\n✨ No duplicates found. Data is squeaky clean.")

    except Exception as e:
        print(f"❌ Error during cleanup: {e}")

if __name__ == "__main__":
    clean_duplicates()
