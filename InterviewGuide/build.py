import glob, os, re, subprocess, sys, io
import markdown
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

here = os.path.dirname(os.path.abspath(__file__))
TITLE = "Java & Spring Boot Senior Developer Interview Preparation Guide"
SUB = "Comprehensive Interview Handbook for 8 Years of Experience"

md = markdown.Markdown(extensions=["fenced_code", "tables", "codehilite", "attr_list", "sane_lists"],
                       extension_configs={"codehilite": {"guess_lang": False, "noclasses": True, "pygments_style": "friendly"}})
body, toc = [], []
for f in sorted(glob.glob(os.path.join(here, "chapters", "*.md"))):
    text = open(f, encoding="utf-8").read()
    md.reset()
    html = md.convert(text)
    def tag(m):
        lvl, inner = m.group(1), m.group(2)
        plain = re.sub("<.*?>", "", inner)
        i = len(toc)
        toc.append((int(lvl), plain, f"s{i}"))
        return f'<h{lvl} id="s{i}">{inner}</h{lvl}>'
    html = re.sub(r"<h([12])>(.*?)</h\1>", tag, html)
    body.append(html)

toc_html = "".join(
    f'<div class="t{l}"><a href="#{i}">{t}</a></div>' for l, t, i in toc)
css = """
@page :first { margin:0 }
@page { size: A4; margin: 18mm 16mm 20mm 16mm; }
body { margin:0; font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 10.3pt; line-height: 1.5; color:#1b1f24; }
h1 { font-size: 24pt; color:#0b3d6e; border-bottom: 3px solid #0b3d6e; padding-bottom:6px; page-break-before: always; margin-top:0 }
h2 { font-size: 15pt; color:#0b3d6e; margin-top: 22px; border-bottom:1px solid #c9d6e4; padding-bottom:3px; page-break-after: avoid; }
h3 { font-size: 12pt; color:#14507f; margin-top: 16px; page-break-after: avoid; }
h4 { font-size: 10.8pt; color:#444; page-break-after: avoid; }
code { font-family: Consolas, 'Courier New', monospace; font-size: 9pt; background:#eef2f6; padding:1px 4px; border-radius:3px; }
pre, .codehilite { background:#f6f8fa !important; border:1px solid #d8dee4; border-radius:5px; padding:8px 10px; font-size:8.6pt; line-height:1.38; white-space: pre-wrap; word-wrap: break-word; page-break-inside: auto; }
pre code { background:none; padding:0; font-size:8.6pt; }
.codehilite pre { border:none; padding:0; margin:0; background:none !important; }
table { border-collapse: collapse; width:100%; margin:10px 0; font-size:9.3pt; page-break-inside: avoid; }
th { background:#0b3d6e; color:#fff; text-align:left; padding:5px 7px; }
td { border:1px solid #cfd8e3; padding:4px 7px; vertical-align: top; }
tr:nth-child(even) td { background:#f4f7fb; }
blockquote { border-left:4px solid #e3a008; background:#fff8e6; margin:10px 0; padding:6px 12px; }
.cover { display:flex; flex-direction:column; justify-content:center; text-align:center; background: linear-gradient(160deg,#0b3d6e,#14507f 60%,#1f7a8c); color:#fff; padding:0 20mm; height:290mm; box-sizing:border-box; overflow:hidden; }
.cover h1 { color:#fff; border:none; font-size:34pt; page-break-before: avoid; line-height:1.2 }
.cover .sub { font-size:16pt; margin-top:14px; opacity:.95 }
.cover .meta { margin-top:60px; font-size:11pt; opacity:.85 }
.toc { page-break-before: always; }
.toc h1 { page-break-before: avoid; }
.t1 { font-weight:700; margin-top:9px; font-size:11pt } .t2 { margin-left:18px; font-size:9.3pt }
.toc a { color:#1b1f24; text-decoration:none }
.say { background:#e8f5e9; border-left:4px solid #2e7d32; padding:6px 12px; margin:10px 0; page-break-inside: avoid;}
"""
cover = f'<div class="cover"><h1>{TITLE}</h1><div class="sub">{SUB}</div><div class="meta">Java 8 to 21 &bull; Spring Boot 2/3 &bull; Microservices &bull; SQL &bull; System Design<br/>Concepts &bull; Code &bull; Scenarios &bull; Interview-ready answers</div></div>'
html = f'<!doctype html><html><head><meta charset="utf-8"><title>{TITLE}</title><style>{css}</style></head><body>{cover}<div class="toc"><h1>Table of Contents</h1>{toc_html}</div>{"".join(body)}</body></html>'
hp = os.path.join(here, "book.html")
open(hp, "w", encoding="utf-8").write(html)

chrome = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
raw = os.path.join(here, "raw.pdf")
subprocess.run([chrome, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                f"--print-to-pdf={raw}", "file:///" + hp.replace("\\", "/")], check=True, timeout=300)

r = PdfReader(raw); w = PdfWriter()
for n, page in enumerate(r.pages):
    if n > 0:
        buf = io.BytesIO(); c = canvas.Canvas(buf, pagesize=(float(page.mediabox.width), float(page.mediabox.height)))
        c.setFont("Helvetica", 8); c.setFillGray(0.4)
        c.drawCentredString(float(page.mediabox.width)/2, 22, f"{n+1}   |   Java & Spring Boot Senior Developer Interview Guide")
        c.save(); buf.seek(0); page.merge_page(PdfReader(buf).pages[0])
    w.add_page(page)
w.add_metadata({"/Title": TITLE, "/Subject": SUB})
out = os.path.join(here, "Java_SpringBoot_Senior_Interview_Guide.pdf")
w.write(open(out, "wb")); os.remove(raw)
print("pages:", len(r.pages), out)
