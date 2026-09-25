import { useEffect, useState } from "react";
import { RefreshCw, Zap, Globe, FolderOpen } from "lucide-react";
import { discoverSkills, updateSkillSettings, type Skill } from "../../lib/skillManager";

interface Props { projectPath?: string; }
export function SkillsSection({ projectPath }: Props) {
  const [skills,setSkills]=useState<Skill[]>([]); const [loading,setLoading]=useState(true);
  async function refresh(){setLoading(true);setSkills(await discoverSkills(projectPath));setLoading(false);}
  useEffect(()=>{void refresh();},[projectPath]);
  return <div className="sp-section">
    <div className="sp-prompts-header"><div><div className="sp-section-heading">Skills</div><p className="sp-section-desc" style={{marginBottom:0}}>Reusable SKILL.md instructions for your agents.</p></div><button className="sp-prompts-new-btn" onClick={()=>void refresh()} disabled={loading}><RefreshCw size={12}/> Refresh</button></div>
    <div style={{display:"grid",gap:8,marginTop:16}}>
      <div className="sp-section-desc"><strong>Global:</strong> ~/.andro/skills{projectPath&&<> · <strong>Project:</strong> {projectPath}/.andro/skills</>}</div>
      {loading&&<div className="sp-section-desc">Scanning skills…</div>}
      {!loading&&!skills.length&&<div className="sp-section-desc" style={{padding:"24px 0"}}>No skills found. Add <code>SKILL.md</code> under <code>.andro/skills/&lt;skill&gt;/</code>.</div>}
      {skills.map(skill=><div key={skill.id} style={{border:"1px solid var(--border-color,rgba(255,255,255,.08))",borderRadius:8,padding:12}}>
        <div style={{display:"flex",alignItems:"center",gap:9}}>{skill.scope==="global"?<Globe size={14}/>:<FolderOpen size={14}/>}<strong style={{flex:1}}>{skill.name}</strong><label style={{display:"flex",alignItems:"center",gap:6,fontSize:12}}><input type="checkbox" checked={skill.enabled} onChange={e=>{updateSkillSettings(skill,{enabled:e.target.checked});setSkills(all=>all.map(s=>s.id===skill.id?{...s,enabled:e.target.checked}:s));}}/> Enabled</label></div>
        {skill.description&&<div className="sp-section-desc" style={{margin:"7px 0 5px 23px"}}>{skill.description}</div>}
        <div style={{marginLeft:23,fontSize:10,opacity:.55,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{skill.path}</div>
        <div style={{marginLeft:23,marginTop:7,display:"flex",alignItems:"center",gap:5,fontSize:11,opacity:.65}}><Zap size={11}/> {skill.agents.length?skill.agents.join(", "):"All agents"}</div>
      </div>)}
    </div>
  </div>;
}
