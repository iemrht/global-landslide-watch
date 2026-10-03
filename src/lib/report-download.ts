/** Embed the exact report canvas losslessly; Chinese labels remain identical to PNG. */
export async function posterPdf(canvas:HTMLCanvasElement):Promise<Blob> {
  const {jsPDF}=await import('jspdf');
  const landscape=canvas.width>canvas.height;
  const pdf=new jsPDF({orientation:landscape?'landscape':'portrait',unit:'mm',format:'a3',compress:true});
  const pw=pdf.internal.pageSize.getWidth(),ph=pdf.internal.pageSize.getHeight(),margin=8;
  const scale=Math.min((pw-2*margin)/canvas.width,(ph-2*margin)/canvas.height);
  const w=canvas.width*scale,h=canvas.height*scale;
  pdf.addImage(canvas.toDataURL('image/png'),'PNG',(pw-w)/2,(ph-h)/2,w,h,undefined,'FAST');
  pdf.setProperties({title:'Earthquake-triggered landslide report',subject:'Rendered map report; raster image, not vector GIS data',creator:'Global Landslide Watch'});
  return pdf.output('blob');
}
