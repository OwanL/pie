import { readFile } from "node:fs/promises";
import { join } from "node:path";
const cwd=process.argv[2];let actual;try{actual=JSON.parse(await readFile(join(cwd,"answer.json"),"utf8"));}catch{}const valid=actual?.artifactId==="A-17"&&actual?.checksum==="cobalt-731";console.log(JSON.stringify({valid,score:valid?1:0,metrics:{answerValid:valid}}));process.exitCode=valid?0:1;
