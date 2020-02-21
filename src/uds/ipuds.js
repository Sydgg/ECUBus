/* eslint-disable no-unused-vars */
const os = require('os')
const dgram = require('dgram')
const net = require('net')
const { ipcMain } = require('electron')
const sprintf = require('sprintf-js').sprintf
const PORT = 13400
const VER =0x02

class IPUDS {
    constructor(win){
        this.win=win
        this.header=Buffer.from([VER,VER^0xff,0,0,0,0,0,0])
        this.timeout=2000
        this.sDelay=100
        this.cMap={}
        this.typeList=[0,1,2,3,4,5,6,7,8,0x4001,0x4002,0x4003,0x4004,0x8001,0x8002,0x8003]
        this.clientTypeList=[0,4,6,7,0x4002,0x4004,0x8002,0x8003]
        this.udpFd=dgram.createSocket('udp4')
        this.udpFd.on('message',(msg, rinfo)=>{
            var ret=this.parseData(msg)
            if(ret.err===0){
                if(ret.type===4){
                    this.emit('doipDeviceFound',[ret.data,rinfo])
                }
            }
        })
        ipcMain.on('doipTcpDisconnect',(event,arg) => {
            var key=arg.SA.toString()+arg.TA.toString()
            clearTimeout(this.cMap[key].timer)
            this.cMap[key].fd.destroy()
            delete this.cMap[key]
        })
        ipcMain.on('doipTcpDisconnectWithKey',(event,arg) => {
            var key=arg
            clearTimeout(this.cMap[key].timer)
            this.cMap[key].fd.destroy()
            delete this.cMap[key]
        })
        ipcMain.on('doipTcpConnect',(event,arg) => {
            var target=arg[0]
            var active=arg[1]
            var key=active.sa+target.logicalAddr
            if(key in this.cMap){
                this.emit('doipTcpStatus',{
                    key:key,
                    err:-1,
                    msg:'此连接已就存在'}
                )
            }else{
                var item={}
                this.cMap[key]=item
                item.fd=net.createConnection(PORT,target.ip,()=>{
                    item.active=false
                    var msg=this.writeRouteActive(parseInt(active.sa),parseInt(active.activeType),active.option)
                    item.fd.write(msg,()=>{
                        item.timer=setTimeout(() => {
                            item.fd.destroy()
                            delete this.cMap[key]
                            this.emit('doipTcpStatus',{
                                key:key,
                                err:-1,
                                msg:'等待Active Response超时'}
                            )
                        }, active.timeout);
                    })
                })
                item.fd.on('error',(msg)=>{
                    clearTimeout(item.timer)
                    delete this.cMap[key]
                    this.emit('doipTcpStatus',{
                        key:key,
                        err:-1,
                        msg:'连接发生错误'}
                    )
                })
                item.fd.on('end',(msg)=>{
                    clearTimeout(item.timer)
                    delete this.cMap[key]
                    this.emit('doipTcpStatus',{
                        key:key,
                        err:-1,
                        msg:'服务端断开连接'}
                    )
                })
                item.fd.on('data',(msg)=>{
                    clearTimeout(item.timer)
                    var ret=this.parseData(msg)
                    if(ret.err===0){
                        if(ret.type===6){
                            if(item.active===false){
                                item.active=true
                                this.emit('doipTcpStatus',{
                                    key:key,
                                    err:0,
                                    msg:'激活成功',
                                    data:ret.data}
                                )
                            }
                        }
                    }
                })
            }
        })
        ipcMain.on('doipDeviceFind',(event,arg)=>{
            
            var msg
            if(arg.type==='NULL'){
                msg=this.writeReqNULL()
            }else if(arg.type==='EID'){
                msg=this.writeReqEID(Buffer.from(arg.eid,'hex'))
            }else{
                msg=this.writeReqVIN(Buffer.from(arg.vin,'ascii'))
            }
            this.udpFd.send(msg,PORT,arg.multicast)
        })
       

    }
    emit(channel,msg){
        this.win.webContents.send(channel, msg)
    }
    parseData(msg){
        /*header handler*/
        var data=Buffer.from(msg)
        var ret={}
        ret.err=0
        ret.msg='empty'
        if((data.readUInt8(0)!==VER)||data.readUInt8(1)!==(VER^0xff)){
            ret.err=-1
            ret.msg="Incorrect pattern format"
            return ret
        }
        var type=data.readUInt16BE(2)
        if(this.typeList.indexOf(type)===-1){
            ret.err=-1
            ret.msg="Unknown payload type"
            return ret
        }
        var len=data.readUInt32BE(4)
        if(len!==(data.length-8)){
            ret.err=-1
            ret.msg="Invalid payload length"
            return ret
        }
        if(this.clientTypeList.indexOf(type)===-1){
            ret.err=-2
            ret.msg="Discard message"
            return ret
        }
        /*real parse*/
        var payload=Buffer.from(data.slice(8))
        ret.type=type
        ret.data={}
        if(type===4&&payload.length>=32){
            ret.data.vin=payload.slice(0,17).toString('ascii')
            ret.data.logicalAddr=payload.readUInt16BE(17)
            ret.data.eid=payload.slice(19,25).toString('hex')
            ret.data.gid=payload.slice(25,31).toString('hex')
            ret.data.fAction=payload.readUInt8(31)
            if(payload.length==33){
                ret.data.syncStatus=payload.readUInt8(32)
            }
        }else if(type===6){
            ret.data.testerAddr=payload.readUInt16BE(0)
            ret.data.entityAddr=payload.readUInt16BE(2)
            ret.data.code=payload.readUInt8(4)
            if(payload.length==13){
                ret.data.option=payload.readUInt32BE(9)
            }
        }else if(type===0x8002){
            ret.data.sa=payload.readUInt16BE(0)
            ret.data.ta=payload.readUInt16BE(2)
            ret.data.code=payload.readUInt8(4)
            ret.data.payload=payload.slice(5).toString('hex')
        }else if(type===0x8003){
            // ret.err=-1
            // ret.msg='Negative diagnostic message'
            ret.data.sa=payload.readUInt16BE(0)
            ret.data.ta=payload.readUInt16BE(2)
            ret.data.code=payload.readUInt8(4)
            ret.data.payload=payload.slice(5).toString('hex')
        }
        else if(type===7){
            //todo active request
        }else if(type===0x4004){
            ret.data.powerMode=payload.readUInt8(0)
        }else if(type===0x4002){
            ret.data.nt=payload.readUInt8(0)
            ret.data.mcts=payload.readUInt8(1)
            ret.data.ncts=payload.readUInt8(2)
            if(payload.length===7){
                ret.data.mds=payload.readUInt32BE(3)
            }
        }
        return ret
    }
    
    changeLen(len){
        this.header.writeUInt32BE(len,4)
    }
    changeType(type){
        this.header.writeUInt16BE(type,2)
    }
    writeReqNULL(){
        this.changeLen(0)
        this.changeType(1)
        return this.header
    }
    writeReqEID(eid){
        this.changeLen(6)
        this.changeType(2)
        return Buffer.concat([this.header,Buffer.from(eid,'binary')],this.header.length+6)
    }
    writeReqVIN(vin){
        this.changeLen(17)
        this.changeType(3)
        return Buffer.concat([this.header,Buffer.from(vin,'ascii')],this.header.length+17)
    }
    writeRouteActive(sa,activeType,option){
        var len=0
        if(option!==''){
            len=4
        }
        this.changeLen(7+len)
        this.changeType(5)
        var b=Buffer.alloc(7+len,0)
        if(len>0){
            Buffer.from(option,'hex').copy(b,7)
        }
        
        b.writeUInt16BE(sa,0)
        b.writeUInt8(activeType,2)
        return Buffer.concat([this.header,b],this.header.length+b.length)
    }
    writeReqAlive(writer){
        this.changeLen(0)
        this.changeType(7)
        return writer(this.header)
    }
    writeReqDiaPowerMode(writer){
        this.changeLen(0)
        this.changeType(0x4003)
        return writer(this.header)
    }
    writeReqDoipStatus(writer){
        this.changeLen(0)
        this.changeType(0x4001)
        return writer(this.header)
    }
    writeDiaMsg(writer,sa,ta,ud){
        var b=Buffer.alloc(4+ud.length,0)
        Buffer.from(ud).copy(b,4)
        b.writeUInt16BE(sa,0)
        b.writeUInt16BE(ta,2)
        this.changeLen(b.length)
        this.changeType(0x8001)
        return writer(Buffer.concat([this.header,b],this.header.length+b.length))
    }



}


module.exports = IPUDS