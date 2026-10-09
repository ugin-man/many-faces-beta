#!/usr/bin/env python3
"""Stage attributed real photographs without changing the original catalog."""
import hashlib,html,json,re,time,urllib.request,urllib.parse
from pathlib import Path
TITLES=['Wink.JPG','Clin oeil.png','Artist David Art Wales, 2018.jpg','Alex Bakker - historien néerlandais.jpg','Clare Siobhán sunset.jpg','Cecilia peckaitis.jpg','Beauty girl.jpg','190617 에잇디카페 (규빈) 02.jpg','190816 K-WORLD FESTA 우현 7.jpg','Adèle Haenel Cannes 2016.jpg','Marion Cotillard Cannes 2018.jpg','Tyra Banks(cannes)-.jpg','Juno Temple (34182832121).jpg','Paul Schrader at the 2024 Toronto International Film Festival (cropped) 2.jpg','Stipe Miocic (48086547846) (cropped).jpg','Tony Philp (FIJ) 2015.jpg','Blumio.jpg','IngridDocMarigny.jpg','New Orleans Bulls 2010 Bienville Wink.jpg','NOLA Time Fest V Kym Trailz.jpg']
OUT=Path('public/__wink_qa');OUT.mkdir(parents=True,exist_ok=True)
UA='ManyFacesCoverageAudit/1.0 (https://github.com/ugin-man/many-faces-beta; expression-coverage verification)'
def allowed(url):
    parsed=urllib.parse.urlsplit(url)
    return parsed.scheme=='https' and parsed.hostname in ['commons.wikimedia.org','upload.wikimedia.org'] and not parsed.username
class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,req,fp,code,msg,headers,newurl):
        if not allowed(newurl):raise ValueError('Redirect outside approved Wikimedia hosts')
        return super().redirect_request(req,fp,code,msg,headers,newurl)
opener=urllib.request.build_opener(SafeRedirect)
def read(url,limit=16*1024*1024):
    if not allowed(url):raise ValueError('Unexpected source host: '+str(urllib.parse.urlsplit(url).hostname))
    req=urllib.request.Request(url,headers={'User-Agent':UA})
    with opener.open(req,timeout=45) as res:
        data=res.read(limit+1)
        if len(data)>limit:raise ValueError('Asset exceeds size budget')
        return data

def clean(s):return html.unescape(re.sub('<[^>]+>','',str(s))).strip()
rows=[];failures=[]
for i,title in enumerate(TITLES):
    try:
        params={'action':'query','format':'json','prop':'imageinfo','iiprop':'url|extmetadata|sha1|size','titles':'File:'+title}
        payload=json.loads(read('https://commons.wikimedia.org/w/api.php?'+urllib.parse.urlencode(params)))
        page=next(iter(payload['query']['pages'].values()));info=page['imageinfo'][0];meta=info['extmetadata']
        get=lambda key:clean(meta.get(key,{}).get('value',''))
        license=get('LicenseShortName');license_url=get('LicenseUrl')
        if not (re.fullmatch(r'CC BY(?:-SA)? [234]\.0',license) or license in ['CC0','Public domain','CC0 1.0']):raise ValueError('License not in accepted set: '+license)
        author=get('Artist')
        if not author:raise ValueError('Missing attribution')
        # Original official URL, not thumbnail-rendering proxies. Bounds remain.
        url=info['url'];data=read(url)
        name=f'commons-{i}.jpg';(OUT/name).write_bytes(data)
        rows.append({'file':name,'sourceName':'Wikimedia Commons','sourceUrl':info.get('descriptionurl') or 'https://commons.wikimedia.org/wiki/File:'+urllib.parse.quote(title.replace(' ','_')),'sourceFile':title,'downloadUrl':url,'sourceSha256':hashlib.sha256(data).hexdigest(),'sourceCommonsSha1':info.get('sha1'),'creator':author,'license':license,'licenseUrl':license_url,'attributionRequired':get('AttributionRequired'),'metadataRetrievedUtc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),'changes':'Square face crop, resize, WebP encoding. No mirroring, warping, expression synthesis or AI-generated image.','personalityRights':'No independent model-release verification; copyright license is not a claim of consent to every reuse.'})
    except Exception as e:failures.append({'title':title,'error':str(e)})
    time.sleep(.3)
(OUT/'commons-sources.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2))
Path('work/wink-coverage/sources.json').write_text(json.dumps({'candidates':rows,'failures':failures},ensure_ascii=False,indent=2))
print('WINK_SOURCE_STAGE '+json.dumps({'downloaded':len(rows),'failures':failures},ensure_ascii=False))
