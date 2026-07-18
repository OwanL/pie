import { readFile } from "node:fs/promises";
import { join } from "node:path";
const cwd=process.argv[2];let actual;try{actual=JSON.parse(await readFile(join(cwd,"answer.json"),"utf8"));}catch{}const expected=["ALPHA=REVIR","BETA=PMAL"],valid=JSON.stringify(actual?.normalized)===JSON.stringify(expected);console.log(JSON.stringify({valid,score:valid?1:0,metrics:{answerValid:valid}}));process.exitCode=valid?0:1;
