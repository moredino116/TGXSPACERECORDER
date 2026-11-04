const {Router}=require('express')
const {attachXBrowserRoutes}=require('../lib/x-browser-routes')
const router=Router()
attachXBrowserRoutes(router)
module.exports=router

