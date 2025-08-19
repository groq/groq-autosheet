"use client"
import React from 'react'
import dynamic from 'next/dynamic'
import '../styles.css'

const AppNoSSR = dynamic(() => import('../ui/App.jsx'), { ssr: false })

export default function Page() {
  return <AppNoSSR />
}


