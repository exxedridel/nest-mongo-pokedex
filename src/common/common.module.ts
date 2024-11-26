import { Module } from '@nestjs/common';
import { AxiosAdapter } from './http-adapters/axios.adapter';


@Module({
    providers: [AxiosAdapter],
    exports: [AxiosAdapter]
})
export class CommonModule { }
