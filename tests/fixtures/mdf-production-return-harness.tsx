import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MdfProductionReturnDialog} from '../../src/pages/orderStatusBoard/MdfProductionReturnDialog';

function Harness() {
  const [result,setResult]=useState('');
  return result ? <p role="status">{result}</p> : <MdfProductionReturnDialog
    intent={{source:{kind:'packet',id:'00000000-0000-0000-0000-000000000101'},targetColumn:'parsed',targetTitle:'Файлы на станке'}}
    onCancel={()=>setResult('Отменено')} onReturned={async()=>setResult('Возврат выполнен')}
    columnTitle={key=>key==='parsed'?'Файлы на станке':'Завершённые файлы'}/>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
