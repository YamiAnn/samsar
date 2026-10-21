
import { useMediaQuery } from 'react-responsive';
import TopNav from "./TopNav.tsx";

import MobileTopNav from "./MobileTopNav.tsx";
import { AlertDialog } from "./AlertDialog.tsx";


import { getHeaders } from "../../utils/web.jsx";
import { useNavigate } from "react-router-dom";
import { createBlankVidgenieSession } from '../../utils/vidgenieRouting.js';


const PROCESSOR_SERVER = import.meta.env.VITE_PROCESSOR_API;

export default function OverflowContainer(props) {
  const { children } = props;

  const navigate = useNavigate();

  const resetCurrentSession = () => {
    if (props.resetSession) {
      props.resetSession();
    }
  }

    const addNewVidGPTSession = () => {
      const headers = getHeaders();
      createBlankVidgenieSession(PROCESSOR_SERVER, headers).then(function (sessionId) {
        if (sessionId) navigate(`/vidgenie/${sessionId}`);
      });
    }





  const isMobile = useMediaQuery({ maxWidth: 767 });

  // This shell grows with its content, so the document owns page scrolling.
  // workspace-scroll contains overscroll for bounded panels and would trap
  // wheel/touch input here even though the shell has no internal scroll range.
  return (
    <div className='workspace-page min-h-[100dvh] pb-8' >
      {isMobile ? (
        <MobileTopNav
          resetCurrentSession={resetCurrentSession}
          addNewVidGPTSession={addNewVidGPTSession}
        />
      ) : (
        <TopNav
          resetCurrentSession={resetCurrentSession}


        />
      )}
      <div>
        <AlertDialog />
        {children}
      </div>
    </div>
  )
}
