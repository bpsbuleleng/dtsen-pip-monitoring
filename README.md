# DTSEN PIP/KIP-K Monitoring

Dashboard kondisi verifikasi keluarga pengaju pembaruan DTSEN untuk PIP dan KIP-K (BPS Kabupaten Buleleng). Static site, tanpa build step, data diambil langsung (live) dari Google Sheets.

## Menjalankan lokal

```bash
python3 -m http.server 4173
```

Buka `http://localhost:4173`.

## Struktur

- `index.html`, `assets/style.css`, `assets/app.js` — dashboard.
- `data/snapshot.json` — snapshot data untuk instant load & fallback saat live fetch gagal. **Di-gitignore** karena berisi data pribadi (nama, No KK, nomor HP) apa adanya — jangan ikut di-commit/upload ke GitHub. Tanpa file ini dashboard tetap jalan normal, hanya langsung fetch live saat dibuka (tanpa instant-paint/fallback offline).

Data live diambil langsung dari Google Sheets ("LK Verifikasi Perubahan DTSEN", tab **Database**) via endpoint CSV publik. Supaya live fetch tetap berfungsi setelah di-deploy, tab Database perlu tetap di-share minimal "Anyone with the link – Viewer".

Untuk memperbarui `data/snapshot.json` dengan data terbaru (lokal saja, tidak untuk di-commit), tarik ulang sheet dan regenerasi file tersebut (format: `{ meta: { lastUpdatedLabel }, records: [...] }`, skema field mengikuti `rowsToRecords()` di `assets/app.js`).

---

## Tutorial Replikasi untuk Daerah/Instansi Lain

Dashboard ini dibuat untuk dipakai ulang oleh BPS kabupaten/kota lain (atau instansi mana pun) yang punya pola kerja serupa: rekap verifikasi di Google Sheets, lalu butuh tampilan ringkas untuk menindaklanjuti. Tidak perlu server/backend — cukup Google Sheets + static site.

### 1. Cara kerja singkat

Browser men-download file `index.html`/`assets/*` dari hosting statis (mis. GitHub Pages), lalu `assets/app.js` langsung `fetch()` data dari endpoint CSV publik Google Sheets setiap dashboard dibuka. Tidak ada database atau server tambahan — Google Sheets *adalah* database-nya.

### 2. Siapkan Google Sheet sumber data

Buat/pakai spreadsheet dengan satu tab data (bebas namanya, contoh di sini: **Database**) mengikuti format persis ini:

- **Baris 1–3 adalah header** (diabaikan oleh parser): baris judul/meta, baris nama kolom, baris nomor kolom `(1)`, `(2)`, dst.
- **Data mulai baris ke-4**, dengan kolom A–S (19 kolom) **urut persis** seperti ini:

| Kolom | Field | Catatan |
|---|---|---|
| A | No KK | identitas utama baris; baris dengan A kosong diabaikan (anggap baris sampah) |
| B | Nama Kepala Keluarga | |
| C | Nomor HP | `-` atau kosong = tidak ada nomor |
| D | Status KK | bebas teks, ditampilkan apa adanya |
| E | Tgl Submit | format wajib `YYYY-MM-DD HH.MM`, contoh `2026-09-30 09.12` (titik untuk jam, bukan titik dua) |
| F | Status Verifikasi | harus persis `SESUAI` atau `PERLU DIPERBAIKI` (case-sensitive) |
| G | Tgl Verifikasi | format sama seperti kolom E |
| H | Desil (saat ini) | `-` = kosong |
| I | Versi (saat ini) | |
| J | Desil (sebelumnya) | |
| K | Versi (sebelumnya) | |
| L | Kirim Whatsapp di Akun PST | `TRUE`/`FALSE` |
| M | Tidak terdaftar WA | `TRUE`/`FALSE` |
| N | beda format tapi sebelum ada format resmi | `TRUE`/`FALSE` |
| O | link ke wa | tidak dipakai dashboard (sengaja tidak ditampilkan, demi privasi nomor HP) |
| P | Link kirim | tidak dipakai dashboard |
| Q | Catatan Perbaikan | teks bebas, dipakai untuk panel "Alasan Perbaikan Teratas" |
| R | Hasil Pemutakhiran | harus `Naik` / `Sama` / `Turun` |
| S | Tindak Lanjut | harus `SIAP DICEK ULANG` / `MENUNGGU RESPON` / `SEDANG DIPERBAIKI` / kosong |

Kalau struktur sheet daerah lain beda, cara paling gampang: samakan saja urutan kolom ke format di atas (tambah kolom bantu/formula kalau perlu), supaya tidak perlu ubah kode. Kalau memang mau ubah pemetaan kolom, edit fungsi `rowsToRecords()` di `assets/app.js` (baris ±66).

### 3. Aktifkan akses "live" ke sheet

Dashboard mengambil data lewat endpoint publik Google Visualization, tanpa API key:

```
https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&sheet=<NAMA_TAB>
```

Supaya endpoint ini bisa diakses dari browser siapa pun yang membuka dashboard:

1. Buka spreadsheet → **Share** (Bagikan).
2. Ubah akses ke **"Anyone with the link" / "Siapa saja yang memiliki link"** dengan peran **Viewer**.
3. Tes dengan membuka URL endpoint di atas langsung di browser (ganti `<SHEET_ID>` dan `<NAMA_TAB>`) — kalau yang muncul teks CSV (bukan halaman login), berarti sudah benar.

⚠️ **Penting soal privasi**: dengan akses "anyone with the link", siapa pun yang tahu/menebak URL endpoint itu bisa melihat data mentah (nama, No KK, nomor HP) **tanpa masking** — masking hanya terjadi di tampilan dashboard, bukan di level sheet. Jangan jadikan link spreadsheet publik/dapat diindeks, dan pertimbangkan masak-masak kolom apa saja yang sebaiknya ada di sheet sumber ini.

### 4. Salin proyek & sesuaikan konfigurasi

1. Fork/clone repo ini.
2. Ambil **Sheet ID** dari URL spreadsheet: `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit...`
3. Edit `assets/app.js` baris ±5, isi `CONFIG`:

   ```js
   var CONFIG = {
     sheetId: '<SHEET_ID_MILIK_SENDIRI>',
     sheetName: '<NAMA_TAB_DATA>',   // default: 'Database'
     snapshotUrl: 'data/snapshot.json',
     urgency: { baru: 7, perhatian: 14 } // ambang hari tunggu, boleh disesuaikan
   };
   ```
4. Edit judul/subjudul di `index.html` (elemen `<h1>` dan `.topbar-sub`), dan footer sumber data.
5. Jalankan lokal (lihat bagian atas README) untuk pastikan data muncul benar sebelum deploy.

### 5. Deploy (contoh: GitHub Pages)

1. Push repo ke GitHub (pastikan `.gitignore` sudah ada supaya `data/snapshot.json` tidak ikut ter-upload).
2. Di repo GitHub → **Settings → Pages** → Source pilih branch `main`, folder `/ (root)`.
3. Tunggu beberapa menit, dashboard akan tersedia di `https://<username>.github.io/<nama-repo>/`.
4. Hosting statis lain (Netlify, Cloudflare Pages, intranet BPS, dsb.) juga bisa — tidak ada kebutuhan server/runtime khusus, tinggal upload isi folder ini.

### 6. (Opsional) Snapshot untuk instant-load

`data/snapshot.json` dipakai supaya dashboard langsung tampil (tidak blank) sebelum live fetch selesai, dan sebagai fallback kalau live fetch gagal. File ini **sengaja tidak di-commit** (lihat `.gitignore`) karena isinya data pribadi mentah. Kalau mau tetap dipakai secara lokal, buat JSON dengan skema:

```json
{
  "meta": { "lastUpdatedLabel": "1 Oktober 2026 9:00" },
  "records": [ { "noKK": "...", "nama": "...", "...": "... (lihat rowsToRecords() di assets/app.js untuk daftar field lengkap)" } ]
}
```

Tanpa file ini, dashboard tetap berfungsi normal — hanya langsung fetch live saat dibuka.

### 7. Kustomisasi lain yang umum diubah

- **Warna/branding** — token warna ada di `:root` pada `assets/style.css` — memakai palet logo Sensus Ekonomi 2026: oranye `--accent` (#F89039), kuning `--accent-2` (#FFBC28), arang `--ink` (#201820); sisanya netral hangat (`--neutral*`).
- **Ambang urgensi "hari menunggu"** — `CONFIG.urgency` di `assets/app.js`.
- **Aturan masking No KK/nomor HP** — fungsi `maskNoKK()` dan `maskPhone()` di `assets/app.js`.
- **Kategori "Alasan Perbaikan Teratas"** — fungsi `categorizeReason()` di `assets/app.js`, sesuaikan kata kunci dengan jenis catatan verifikator setempat.
