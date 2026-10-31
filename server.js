const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const yauzl = require("yauzl");
const archiver = require("archiver");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = path.join(__dirname, "workspace");
const UPLOADS = path.join(ROOT, "uploads");
const JOBS = path.join(ROOT, "jobs");
for (const d of [ROOT, UPLOADS, JOBS]) fs.mkdirSync(d, {recursive:true});
app.use(express.json({limit:"2mb"}));
app.use(express.static(path.join(__dirname,"public")));

const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOADS),
  filename: (_, file, cb) => cb(null, crypto.randomUUID() + path.extname(file.originalname).toLowerCase())
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024, files: 1 },
  fileFilter: (_, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (![".zip"].includes(ext)) return cb(new Error("يرجى رفع ملف ZIP فقط في هذه النسخة."));
    cb(null,true);
  }
});

function safePath(root, rel) {
  const normalized = path.normalize(String(rel || "").replace(/\\/g,"/"));
  if (!normalized || normalized.startsWith("..") || path.isAbsolute(normalized)) throw new Error("مسار غير صالح");
  const full = path.resolve(root, normalized);
  if (!full.startsWith(path.resolve(root) + path.sep)) throw new Error("مسار خارج مساحة العمل");
  return full;
}
function extractZip(zipPath, dest) {
  return new Promise((resolve,reject) => {
    let count=0, total=0;
    yauzl.open(zipPath,{lazyEntries:true,decodeStrings:true},(err,zip)=>{
      if(err) return reject(err);
      zip.readEntry();
      zip.on("entry", entry=>{
        try {
          const name=entry.fileName.replace(/\\/g,"/");
          if(name.startsWith("/") || name.split("/").includes("..")) throw new Error("الأرشيف يحتوي مسارًا غير آمن");
          const out=safePath(dest,name);
          if(name.endsWith("/")) {
            fs.mkdirSync(out,{recursive:true}); zip.readEntry(); return;
          }
          count++;
          if(count>50000) throw new Error("عدد الملفات يتجاوز الحد الآمن (50000)");
          fs.mkdirSync(path.dirname(out),{recursive:true});
          zip.openReadStream(entry,(e,stream)=>{
            if(e) return reject(e);
            const ws=fs.createWriteStream(out);
            stream.on("data",chunk=>{ total+=chunk.length; if(total>2*1024*1024*1024){stream.destroy(new Error("حجم فك الضغط تجاوز 2GB"));}});
            stream.pipe(ws);
            ws.on("finish",()=>zip.readEntry());
            ws.on("error",reject); stream.on("error",reject);
          });
        } catch(e){ reject(e); }
      });
      zip.on("end",()=>resolve({count,total}));
      zip.on("error",reject);
    });
  });
}
function walk(dir, rel="") {
  let out=[];
  for(const item of fs.readdirSync(dir,{withFileTypes:true})) {
    const r=path.posix.join(rel,item.name), p=path.join(dir,item.name);
    if(item.isDirectory()) out=out.concat(walk(p,r));
    else out.push({path:r,size:fs.statSync(p).size,ext:path.extname(item.name).toLowerCase()});
  }
  return out;
}
const jobs = new Map();

app.post("/api/upload", upload.single("archive"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"لم يصل ملف"});
  const id=crypto.randomUUID();
  const dir=path.join(JOBS,id); fs.mkdirSync(dir,{recursive:true});
  try {
    const result=await extractZip(req.file.path,dir);
    const entries=walk(dir);
    jobs.set(id,{dir,entries,original:req.file.originalname});
    res.json({id,original:req.file.originalname,extracted:result.count,expandedBytes:result.total,entries});
  } catch(e) {
    fs.rmSync(dir,{recursive:true,force:true});
    res.status(400).json({error:"تعذر فك الأرشيف: "+e.message});
  } finally { fs.rmSync(req.file.path,{force:true}); }
});
app.get("/api/jobs/:id/files",(req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:"المشروع غير موجود"});
  res.json({entries:job.entries});
});
app.get("/api/jobs/:id/text",(req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:"المشروع غير موجود"});
  try {
    const p=safePath(job.dir,req.query.path);
    const st=fs.statSync(p);
    if(st.size>2*1024*1024) return res.status(413).json({error:"الملف النصي أكبر من 2MB"});
    const buf=fs.readFileSync(p);
    if(buf.includes(0)) return res.status(415).json({error:"هذا ملف ثنائي وليس ملف نصيًا"});
    res.json({path:req.query.path,content:buf.toString("utf8")});
  } catch(e){res.status(400).json({error:e.message});}
});
app.put("/api/jobs/:id/text",(req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:"المشروع غير موجود"});
  try {
    if(typeof req.body.content!=="string" || Buffer.byteLength(req.body.content)>2*1024*1024) throw new Error("محتوى غير صالح أو أكبر من 2MB");
    const p=safePath(job.dir,req.body.path);
    if(!fs.existsSync(p) || !fs.statSync(p).isFile()) throw new Error("الملف غير موجود");
    const ext=path.extname(p).toLowerCase();
    if(![".txt",".ini",".cfg",".xml",".json",".meta",".lua",".ymt",".ytyp"].includes(ext)) throw new Error("هذا الامتداد غير مفعّل للتحرير النصي");
    fs.writeFileSync(p,req.body.content,"utf8");
    job.entries=walk(job.dir);
    res.json({ok:true});
  } catch(e){res.status(400).json({error:e.message});}
});
app.get("/api/jobs/:id/report",(req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:"المشروع غير موجود"});
  const extCounts={}; for(const f of job.entries) extCounts[f.ext||"(بدون امتداد)"]=(extCounts[f.ext||"(بدون امتداد)"]||0)+1;
  const report={
    project:job.original,generatedAt:new Date().toISOString(),
    target:"GTA V PS4 / GoldHEN 1.56 (target only; not validated)",
    files:job.entries.length,extensions:extCounts,
    detected:{yft:job.entries.filter(f=>f.ext===".yft").length,ytd:job.entries.filter(f=>f.ext===".ytd").length,meta:job.entries.filter(f=>f.ext===".meta").length},
    status:"inspection_only",
    limitations:["هذا التقرير يفحص بنية الملفات فقط.","لا يتم تحويل YFT/YTD إلى صيغ PS4 ولا إنشاء RPF صالح في هذه النسخة.","التوافق يحتاج أدوات متخصصة واختبارًا على نسخة اللعبة المستهدفة."]
  };
  res.json(report);
});
app.get("/api/jobs/:id/download",(req,res)=>{
  const job=jobs.get(req.params.id); if(!job) return res.status(404).json({error:"المشروع غير موجود"});
  res.attachment("Z7R-Store-"+req.params.id+".zip");
  const archive=archiver("zip",{zlib:{level:6}});
  archive.on("error",e=>res.status(500).end(e.message));
  archive.pipe(res); archive.directory(job.dir,false); archive.finalize();
});
app.get("/api/health",(_,res)=>res.json({ok:true,maxUploadBytes:1024*1024*1024}));
app.use((err,req,res,next)=>{
  if(err instanceof multer.MulterError && err.code==="LIMIT_FILE_SIZE") return res.status(413).json({error:"حجم الملف تجاوز 1GB"});
  res.status(400).json({error:err.message||"حدث خطأ"});
});
app.listen(PORT,()=>console.log(`Z7R Store running on http://localhost:${PORT}`));
